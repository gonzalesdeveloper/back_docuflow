import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import pool from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extractDocumentText } from '../services/document-extractor.service';

import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const router = Router();

const uploadDirectory = path.resolve(
  process.cwd(),
  'uploads',
  'documents'
);


interface DownloadDocumentRow extends RowDataPacket {
    original_name: string;
    stored_name: string;
    mime_type: string;
}

fs.mkdirSync(uploadDirectory, { recursive: true });

const allowedTypes: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.doc': ['application/msword'],
  '.docx': [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg']
};

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, uploadDirectory);
  },
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${randomUUID()}${extension}`);
  }
});

const multerUpload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const validMimes = allowedTypes[extension];

    if (!validMimes || !validMimes.includes(file.mimetype)) {
      callback(new Error(
        'Formato no permitido. Sube un PDF, Word o imagen compatible.'
      ));
      return;
    }

    callback(null, true);
  }
});

function handleUpload(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  multerUpload.single('file')(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? 'El archivo supera el límite de 10 MB.'
          : 'No se pudo recibir el archivo.';

      res.status(400).json({ success: false, message });
      return;
    }

    if (error) {
      res.status(400).json({
        success: false,
        message: error instanceof Error
          ? error.message
          : 'Archivo no válido.'
      });
      return;
    }

    next();
  });
}

interface DocumentRow extends RowDataPacket {
  id: number;
  original_name: string;
  mime_type: string;
  file_extension: string;
  file_size: number;
  status: string;
  created_at: Date;
}

interface StoredDocumentRow extends RowDataPacket {
  id: number;
  stored_name: string;
}

router.use(authenticateToken);



/**
 * Crear una plantilla a partir de un documento existente.
 * POST /api/documents/:id/template
 */
router.post('/:id/template', async (req: Request, res: Response) => {
  let connection;

  try {
    connection = await pool.getConnection();

    const documentId = Number(req.params.id);
    const userId = res.locals.userId;

    const { name, description, fields } = req.body;

    if (!Number.isSafeInteger(documentId) || documentId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'El ID del documento no es válido.',
      });
    }

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'El nombre de la plantilla es obligatorio.',
      });
    }

    if (name.trim().length > 180) {
      return res.status(400).json({
        success: false,
        message: 'El nombre no puede superar los 180 caracteres.',
      });
    }

    if (
      description !== undefined &&
      description !== null &&
      typeof description !== 'string'
    ) {
      return res.status(400).json({
        success: false,
        message: 'La descripción no es válida.',
      });
    }

    if (fields !== undefined && !Array.isArray(fields)) {
      return res.status(400).json({
        success: false,
        message: 'Los campos deben enviarse como una lista.',
      });
    }

    const templateFields: Array<{
      field_key: string;
      label: string;
      field_type: string;
      required?: boolean;
      placeholder?: string | null;
      options_json?: string | null;
    }> = fields ?? [];

    if (templateFields.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'Una plantilla no puede tener más de 100 campos.',
      });
    }

    const allowedTypes = [
      'text',
      'textarea',
      'number',
      'date',
      'email',
      'phone',
    ];

    const usedKeys = new Set<string>();

    for (let i = 0; i < templateFields.length; i++) {
      const field = templateFields[i];

      if (
        !field ||
        typeof field.field_key !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(field.field_key) ||
        typeof field.label !== 'string' ||
        !field.label.trim() ||
        field.label.trim().length > 150 ||
        typeof field.field_type !== 'string' ||
        !allowedTypes.includes(field.field_type) ||
        (field.required !== undefined &&
          typeof field.required !== 'boolean') ||
        (field.placeholder !== undefined &&
          field.placeholder !== null &&
          (typeof field.placeholder !== 'string' ||
            field.placeholder.length > 255)) ||
        (field.options_json !== undefined &&
          field.options_json !== null &&
          typeof field.options_json !== 'string')
      ) {
        return res.status(400).json({
          success: false,
          message: `El campo número ${i + 1} contiene datos no válidos.`,
        });
      }

      if (usedKeys.has(field.field_key)) {
        return res.status(400).json({
          success: false,
          message: `La clave "${field.field_key}" está repetida.`,
        });
      }

      usedKeys.add(field.field_key);
    }

    await connection.beginTransaction();

    // 1. Buscar el documento del usuario.
    const [documents] = await connection.execute<RowDataPacket[]>(
      `SELECT
          id,
          original_name,
          stored_name,
          file_extension,
          extracted_text
       FROM documents
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [documentId, userId]
    );

    if (documents.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: 'Documento no encontrado.',
      });
    }

    const document = documents[0];
    const extension = String(document.file_extension).toLowerCase();

    // 2. Identificar el formato.
    let sourceFormat: 'docx' | 'pdf' | 'image';

    if (extension === 'pdf') {
      sourceFormat = 'pdf';
    } else if (extension === 'docx') {
      sourceFormat = 'docx';
    } else if (['png', 'jpg', 'jpeg'].includes(extension)) {
      sourceFormat = 'image';
    } else {
      await connection.rollback();

      return res.status(415).json({
        success: false,
        message:
          'El formato de este documento no es compatible con las plantillas.',
      });
    }

    // 3. Comprobar si ya existe texto extraído.
    let extractedText: string | null = document.extracted_text || null;

    // 4. Si no existe, intentar extraerlo automáticamente.
    if (!extractedText && ['pdf', 'docx'].includes(extension)) {
      try {
        extractedText = await extractDocumentText(
          document.stored_name,
          extension
        );

        // Guardar el texto en la tabla documents.
        await connection.execute(
          `UPDATE documents
           SET extracted_text = ?, extracted_at = NOW()
           WHERE id = ? AND user_id = ?`,
          [extractedText, documentId, userId]
        );

      } catch (extractionError) {
        await connection.rollback();

        console.error(
          'Error al extraer texto antes de crear plantilla:',
          extractionError
        );

        return res.status(422).json({
          success: false,
          message: extractionError instanceof Error
            ? extractionError.message
            : 'No se pudo extraer el texto del documento.',
        });
      }
    }

    // 5. No permitir crear una plantilla sin texto disponible.
    if (!extractedText) {
      await connection.rollback();

      return res.status(422).json({
        success: false,
        message:
          'Este documento todavía no tiene texto disponible para asociar campos. Por ahora utiliza un archivo PDF o DOCX con texto seleccionable.',
      });
    }

    // 6. Crear la plantilla.
    const [templateResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO templates
       (
         user_id,
         source_document_id,
         title,
         original_filename,
         source_format,
         storage_path
       )
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        documentId,
        name.trim(),
        document.original_name,
        sourceFormat,
        document.stored_name,
      ]
    );

    const templateId = templateResult.insertId;

    // 7. Crear los campos de la plantilla.
    for (let i = 0; i < templateFields.length; i++) {
      const field = templateFields[i];

      await connection.execute(
        `INSERT INTO template_fields
         (
           template_id,
           field_key,
           label,
           field_type,
           required,
           placeholder,
           options_json,
           sort_order
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          templateId,
          field.field_key,
          field.label.trim(),
          field.field_type,
          field.required ? 1 : 0,
          field.placeholder ?? null,
          field.options_json ?? null,
          i,
        ]
      );
    }

    // 8. Confirmar la operación.
    await connection.commit();

    return res.status(201).json({
      success: true,
      message: 'Plantilla creada correctamente.',
      template: {
        id: templateId,
        document_id: documentId,
        title: name.trim(),
        original_filename: document.original_name,
        source_format: sourceFormat,
        fields_count: templateFields.length,
      },
    });

  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => undefined);
    }

    console.error('Error al crear plantilla:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudo crear la plantilla.',
    });

  } finally {
    connection?.release();
  }
});



// GET /api/documents
router.get('/', async (_req, res) => {
  const userId = res.locals.userId as number;

  try {
    const [documents] = await pool.execute<DocumentRow[]>(
      `SELECT id, original_name, mime_type, file_extension,
              file_size, status, created_at
       FROM documents
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    return res.json({
      success: true,
      documents
    });
  } catch (error) {
    console.error('Error al listar documentos:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudieron consultar los documentos.'
    });
  }
});
/* encontrar documento */
router.get('/:id/text', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const userId = res.locals.userId;

    if (!Number.isSafeInteger(id) || id <= 0) {
      res.status(400).json({
        success: false,
        message: 'El ID del documento no es válido.',
      });
      return;
    }

    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT id, original_name, stored_name, file_extension
       FROM documents
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [id, userId]
    );

    if (rows.length === 0) {
      res.status(404).json({
        success: false,
        message: 'Documento no encontrado.',
      });
      return;
    }

    const doc = rows[0];

    const filePath = path.join(
      uploadDirectory,
      doc.stored_name
    );

    if (!fs.existsSync(filePath)) {
      res.status(404).json({
        success: false,
        message: 'El archivo físico no se encuentra en el servidor.',
      });
      return;
    }

    const buffer = await fs.promises.readFile(filePath);
    const extension = String(doc.file_extension).toLowerCase();

    let extractedText = '';

    if (extension === 'pdf') {
      const result = await pdfParse(buffer);
      extractedText = result.text;
    } else if (extension === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value;
    } else {
      res.status(415).json({
        success: false,
        message: 'Por ahora solo podemos leer PDF y DOCX.',
      });
      return;
    }

    extractedText = extractedText.trim();

    if (!extractedText) {
      res.status(422).json({
        success: false,
        message:
          extension === 'pdf'
            ? 'Este PDF no contiene texto extraíble. Puede necesitar OCR.'
            : 'No se encontró texto en el documento.',
      });
      return;
    }

    await pool.execute<ResultSetHeader>(
      `UPDATE documents
       SET extracted_text = ?, extracted_at = NOW()
       WHERE id = ? AND user_id = ?`,
      [extractedText, doc.id, userId]
    );

    res.json({
      success: true,
      document: {
        id: doc.id,
        name: doc.original_name,
        extension,
      },
      text: extractedText,
      characters: extractedText.length,
    });
  } catch (error) {
    console.error('Error al extraer texto:', error);

    res.status(500).json({
      success: false,
      message: 'No se pudo leer el contenido del documento.',
    });
  }
});

// POST /api/documents
router.post('/', handleUpload, async (req, res) => {
  const userId = res.locals.userId as number;
  const file: any = req.file;

  if (!file) {
    return res.status(400).json({
      success: false,
      message: 'Selecciona un archivo para subir.'
    });
  }

  const extension = path.extname(file.originalname)
    .toLowerCase()
    .replace(/^\./, '');

  try {
    // 1. Registrar primero el documento en MySQL.
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO documents
        (
          user_id,
          original_name,
          stored_name,
          mime_type,
          file_extension,
          file_size,
          status
        )
       VALUES (?, ?, ?, ?, ?, ?, 'uploaded')`,
      [
        userId,
        path.basename(file.originalname).slice(0, 255),
        file.filename,
        file.mimetype,
        extension,
        file.size
      ]
    );

    const documentId : any = result.insertId;

    // 2. Extraer automáticamente el texto cuando sea compatible.
    let extractedText: string | null = null;
    let extractionMessage: string | null = null;

    if (['pdf', 'docx'].includes(extension)) {
      try {
        extractedText = await extractDocumentText(
          file.filename,
          extension
        );

        // 3. Guardar el texto extraído.
        await pool.execute<ResultSetHeader>(
          `UPDATE documents
           SET extracted_text = ?, extracted_at = NOW()
           WHERE id = ? AND user_id = ?`,
          [extractedText, documentId, userId]
        );
      } catch (extractionError) {
        console.error(
          'Error en extracción automática:',
          extractionError
        );

        extractionMessage = extractionError instanceof Error
          ? extractionError.message
          : 'No se pudo extraer el texto.';
      }
    } else {
      extractionMessage =
        'Este formato todavía no cuenta con extracción automática de texto.';
    }

    // 4. Responder con el resultado de la subida y extracción.
    return res.status(201).json({
      success: true,
      message: 'Documento subido correctamente.',
      document: {
        id: documentId,
        name: path.basename(file.originalname),
        size: file.size,
        status: 'uploaded',
        extracted: extractedText !== null,
        extracted_characters: extractedText?.length ?? 0,
        extraction_message: extractionMessage
      }
    });

  } catch (error) {
    // Si falla el registro, retiramos el archivo físico.
    await fs.promises.unlink(file.path).catch(() => undefined);

    console.error('Error al guardar documento:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudo guardar el documento.'
    });
  }
});

// DELETE /api/documents/:id
router.delete('/:id', async (req, res) => {
  const userId = res.locals.userId as number;
  const documentId = Number(req.params.id);

  if (!Number.isSafeInteger(documentId) || documentId <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Identificador de documento no válido.'
    });
  }

  try {
    const [documents] = await pool.execute<StoredDocumentRow[]>(
      `SELECT id, stored_name
       FROM documents
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [documentId, userId]
    );

    if (documents.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Documento no encontrado.'
      });
    }

    const storedName = documents[0].stored_name;

    const [result] = await pool.execute<ResultSetHeader>(
      `DELETE FROM documents
       WHERE id = ? AND user_id = ?`,
      [documentId, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: 'Documento no encontrado.'
      });
    }

    // El nombre interno es generado por el servidor.
    const storedPath = path.join(uploadDirectory, storedName);

    await fs.promises.unlink(storedPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('No se pudo eliminar el archivo:', error);
      }
    });

    return res.json({
      success: true,
      message: 'Documento eliminado correctamente.'
    });
  } catch (error) {
    console.error('Error al eliminar documento:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudo eliminar el documento.'
    });
  }
});

// GET /api/documents/:id/download
router.get('/:id/download', async (req, res) => {
    const userId = res.locals.userId as number;
    const documentId : any = Number(req.params.id);
  
    if (!Number.isSafeInteger(documentId) || documentId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Identificador de documento no válido.'
      });
    }
  
    try {
      const [rows] = await pool.execute<DownloadDocumentRow[]>(
        `SELECT original_name, stored_name, mime_type
         FROM documents
         WHERE id = ? AND user_id = ?
         LIMIT 1`,
        [documentId, userId]
      );
  
      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Documento no encontrado.'
        });
      }
  
      const document = rows[0];
      const filePath = path.resolve(uploadDirectory, document.stored_name);
  
      // Evitar que el nombre interno permita salir de la carpeta.
      if (path.dirname(filePath) !== uploadDirectory) {
        return res.status(400).json({
          success: false,
          message: 'Ruta de archivo no válida.'
        });
      }
  
      return res.download(filePath, document.original_name, (error: any) => {
        if (error && !res.headersSent) {
          console.error('Error al descargar documento:', error);
  
          res.status(error.statusCode === 404 ? 404 : 500).json({
            success: false,
            message: error.statusCode === 404
              ? 'El archivo ya no está disponible.'
              : 'No se pudo descargar el documento.'
          });
        }
      });
    } catch (error) {
      console.error('Error al consultar documento:', error);
  
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message: 'No se pudo descargar el documento.'
        });
      }
    }
  });

export default router;
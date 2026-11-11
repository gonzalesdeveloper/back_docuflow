import { Router } from 'express';
import pool from '../config/database';
import { authenticateToken } from '../middlewares/auth.middleware';
import { extractDocumentText } from '../services/document-extractor.service';
import path from 'node:path';
import { generateDocxFromMappings } from '../services/document-generator-a2.service';
import fs from 'node:fs/promises';
import { generatePdfFromMappings } from '../services/pdf-generator.service';

const router = Router();

interface TemplateFieldUpdate {
  id?: number;
  field_key: string;
  label: string;
  field_type: string;
  required: boolean;
  placeholder?: string | null;
  options_json?: string | null;
}

router.use(authenticateToken);

// Obtener las plantillas del usuario autenticado
router.get('/', async (req, res) => {
  try {
    const userId = res.locals.userId;

    const [templates]: any = await pool.query(
      `
      SELECT
        t.id,
        t.title,
        t.original_filename,
        t.source_format,
        t.status,
        t.created_at,
        t.updated_at,
        t.source_document_id,
        (
          SELECT COUNT(*)
          FROM template_fields tf
          WHERE tf.template_id = t.id
        ) AS fields_count
      FROM templates t
      WHERE t.user_id = ?
      ORDER BY t.created_at DESC
      `,
      [userId]
    );

    return res.json({
      success: true,
      templates
    });

  } catch (error) {
    console.error('Error al obtener plantillas:', error);

    return res.status(500).json({
      success: false,
      message: 'Error al obtener las plantillas'
    });
  }
});

// ============================================
// HISTORIAL DE DOCUMENTOS GENERADOS
// ============================================

// Obtener el historial del usuario autenticado
// GET /api/templates/history
router.get('/history', async (_req, res) => {
  try {
    const userId = res.locals.userId;

    const [documents]: any = await pool.query(
      `
      SELECT
        gd.id,
        gd.template_id,
        t.title AS template_title,
        gd.output_filename,
        gd.output_format,
        gd.status,
        gd.created_at
      FROM generated_documents gd
      INNER JOIN templates t
        ON t.id = gd.template_id
      WHERE gd.user_id = ?
      ORDER BY gd.created_at DESC, gd.id DESC
      `,
      [userId]
    );

    return res.json({
      success: true,
      documents
    });

  } catch (error) {
    console.error('Error al obtener historial:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudo obtener el historial de documentos.'
    });
  }
});


// Descargar un documento del historial
// GET /api/templates/history/:id/download
router.get('/history/:id/download', async (req, res) => {
  try {
    const documentId = Number(req.params.id);
    const userId = res.locals.userId;

    if (!Number.isSafeInteger(documentId) || documentId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'El ID del documento no es válido.'
      });
    }

    // Buscar únicamente documentos del usuario autenticado.
    const [documents]: any = await pool.query(
      `
      SELECT
        id,
        output_filename,
        storage_path,
        status
      FROM generated_documents
      WHERE id = ? AND user_id = ?
      LIMIT 1
      `,
      [documentId, userId]
    );

    if (!documents.length) {
      return res.status(404).json({
        success: false,
        message: 'Documento generado no encontrado.'
      });
    }

    const document = documents[0];

    if (document.status !== 'completed') {
      return res.status(409).json({
        success: false,
        message: 'Este documento todavía no está disponible.'
      });
    }

    // Resolver la ruta y asegurar que permanezca dentro de generated.
    const generatedDirectory = path.resolve(
      process.cwd(),
      'uploads',
      'generated'
    );

    const filePath = path.resolve(
      process.cwd(),
      document.storage_path
    );

    const relativePath = path.relative(
      generatedDirectory,
      filePath
    );

    if (
      !relativePath ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      return res.status(403).json({
        success: false,
        message: 'La ruta del documento no es válida.'
      });
    }

    // Comprobar que el archivo existe.
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({
        success: false,
        message: 'El archivo generado ya no se encuentra disponible.'
      });
    }

    return res.download(
      filePath,
      document.output_filename,
      (error) => {
        if (error) {
          console.error('Error al descargar desde historial:', error);

          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              message: 'No se pudo descargar el documento.'
            });
          }
        }
      }
    );

  } catch (error) {
    console.error('Error al descargar documento del historial:', error);

    return res.status(500).json({
      success: false,
      message: 'Ocurrió un error al descargar el documento.'
    });
  }
});

// Eliminar un documento generado del historial
// DELETE /api/templates/history/:id
router.delete('/history/:id', async (req, res) => {
  try {
    const documentId = Number(req.params.id);
    const userId = res.locals.userId;

    if (!Number.isSafeInteger(documentId) || documentId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'El ID del documento no es válido.'
      });
    }

    // Buscar el documento y comprobar que pertenece al usuario.
    const [documents]: any = await pool.query(
      `
      SELECT id, storage_path
      FROM generated_documents
      WHERE id = ? AND user_id = ?
      LIMIT 1
      `,
      [documentId, userId]
    );

    if (!documents.length) {
      return res.status(404).json({
        success: false,
        message: 'Documento generado no encontrado.'
      });
    }

    const document = documents[0];

    // Resolver la ruta y evitar salir de uploads/generated.
    const generatedDirectory = path.resolve(
      process.cwd(),
      'uploads',
      'generated'
    );

    const filePath = path.resolve(
      process.cwd(),
      document.storage_path
    );

    const relativePath = path.relative(
      generatedDirectory,
      filePath
    );

    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath)
    ) {
      return res.status(403).json({
        success: false,
        message: 'La ruta del documento no es válida.'
      });
    }

    // Eliminar el archivo físico.
    try {
      await fs.unlink(filePath);
    } catch (fileError: any) {
      // Si el archivo ya no existe, igualmente podemos limpiar el registro.
      if (fileError.code !== 'ENOENT') {
        throw fileError;
      }
    }

    // Eliminar el registro del historial.
    await pool.execute(
      `
      DELETE FROM generated_documents
      WHERE id = ? AND user_id = ?
      `,
      [documentId, userId]
    );

    return res.json({
      success: true,
      message: 'Documento eliminado correctamente.'
    });

  } catch (error) {
    console.error('Error al eliminar documento generado:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudo eliminar el documento generado.'
    });
  }
});

// GET /api/templates/dashboard/stats
router.get('/dashboard/stats', async (req, res) => {
  try {
    const userId = res.locals.userId;

    const [rows]: any = await pool.query(
      `
      SELECT
        (
          SELECT COUNT(*)
          FROM documents
          WHERE user_id = ?
        ) AS documents_count,

        (
          SELECT COUNT(*)
          FROM templates
          WHERE user_id = ?
        ) AS templates_count,

        (
          SELECT COUNT(*)
          FROM generated_documents
          WHERE user_id = ?
            AND status = 'completed'
        ) AS generated_count
      `,
      [userId, userId, userId]
    );

    return res.json({
      success: true,
      stats: {
        documents: Number(rows[0].documents_count),
        templates: Number(rows[0].templates_count),
        generated: Number(rows[0].generated_count)
      }
    });

  } catch (error) {
    console.error('Error al obtener estadísticas del dashboard:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudieron obtener las estadísticas.'
    });
  }
});

// Obtener el detalle de una plantilla y sus campos
// GET /api/templates/:id
router.get('/:id', async (req, res) => {
  try {
    const templateId = Number(req.params.id);
    const userId = res.locals.userId;

    if (!Number.isSafeInteger(templateId) || templateId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'El ID de la plantilla no es válido.'
      });
    }

    // 1. Obtener plantilla y documento asociado.
    const [templates]: any = await pool.query(
      `
      SELECT
        t.id,
        t.title,
        t.original_filename,
        t.source_format,
        t.storage_path,
        t.status,
        t.source_document_id,
        t.created_at,
        t.updated_at,
        d.extracted_text,
        d.extracted_at,
        d.stored_name,
        d.file_extension
      FROM templates t
      LEFT JOIN documents d
        ON d.id = t.source_document_id
        AND d.user_id = t.user_id
      WHERE t.id = ? AND t.user_id = ?
      LIMIT 1
      `,
      [templateId, userId]
    );

    if (templates.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Plantilla no encontrada.'
      });
    }

    const template = templates[0];

    // 2. Recuperar automáticamente el texto si todavía no existe.
    if (
      !template.extracted_text &&
      template.stored_name &&
      ['docx', 'pdf'].includes(
        String(template.file_extension).toLowerCase()
      )
    ) {
      try {
        const extractedText = await extractDocumentText(
          template.stored_name,
          template.file_extension
        );

        // Guardar el texto recuperado en el documento original.
        await pool.execute(
          `
          UPDATE documents
          SET extracted_text = ?, extracted_at = NOW()
          WHERE id = ? AND user_id = ?
          `,
          [
            extractedText,
            template.source_document_id,
            userId
          ]
        );

        // Actualizar los datos que devolveremos al frontend.
        template.extracted_text = extractedText;
        template.extracted_at = new Date();

      } catch (extractionError) {
        console.error(
          'Error al recuperar texto de plantilla:',
          extractionError
        );

        return res.status(422).json({
          success: false,
          message: extractionError instanceof Error
            ? extractionError.message
            : 'No se pudo recuperar el texto del documento.'
        });
      }
    }

    
// 3. Obtener los campos configurados y su estado de asociación.
  const [fields]: any = await pool.query(
    `
    SELECT
      tf.id,
      tf.field_key,
      tf.label,
      tf.field_type,
      tf.required,
      tf.placeholder,
      tf.options_json,
      tf.sort_order,

      (
        SELECT COUNT(*)
        FROM template_field_mappings tfm
        WHERE tfm.template_field_id = tf.id
      ) AS mappings_count,

      CASE
        WHEN EXISTS (
          SELECT 1
          FROM template_field_mappings tfm
          WHERE tfm.template_field_id = tf.id
        )
        THEN 1
        ELSE 0
      END AS is_associated

    FROM template_fields tf
    WHERE tf.template_id = ?
    ORDER BY tf.sort_order ASC, tf.id ASC
    `,
    [templateId]
  );

    // 4. Devolver la plantilla con su texto y campos.
    return res.json({
      success: true,
      template: {
        ...template,
        fields,
        extracted_text: template.extracted_text ?? null,
        extracted_at: template.extracted_at ?? null
      }
    });

  } catch (error) {
    console.error('Error al obtener detalle de plantilla:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudo obtener el detalle de la plantilla.'
    });
  }
});


// Guardar las asociaciones entre campos y fragmentos del documento
// PUT /api/templates/:id/mappings

router.put('/:id/mappings', async (req, res) => {
  let connection;

  try {
    const templateId = Number(req.params.id);
    const userId = res.locals.userId;
    const { mappings } = req.body;

    if (!Number.isSafeInteger(templateId) || templateId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'El ID de la plantilla no es válido.'
      });
    }

    if (!Array.isArray(mappings) || mappings.length > 500) {
      return res.status(400).json({
        success: false,
        message: 'La lista de asociaciones no es válida.'
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Verificar que la plantilla pertenece al usuario
    const [templates]: any = await connection.execute(
      `
      SELECT
        t.id,
        d.extracted_text
      FROM templates t
      INNER JOIN documents d
        ON d.id = t.source_document_id
        AND d.user_id = t.user_id
      WHERE t.id = ? AND t.user_id = ?
      LIMIT 1
      `,
      [templateId, userId]
    );

    if (templates.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: 'Plantilla o documento asociado no encontrado.'
      });
    }

    const extractedText = templates[0].extracted_text;

    if (typeof extractedText !== 'string' || !extractedText.length) {
      await connection.rollback();

      return res.status(422).json({
        success: false,
        message: 'El documento todavía no tiene texto extraído.'
      });
    }

    // Validar cada asociación
    const validatedMappings: any[] = [];

    for (let i = 0; i < mappings.length; i++) {
      const mapping = mappings[i];

      const fieldId = Number(mapping.template_field_id);
      const originalText = mapping.original_text;
      const startOffset = mapping.start_offset;
      const endOffset = mapping.end_offset;

      if (
        !Number.isSafeInteger(fieldId) ||
        fieldId <= 0 ||
        typeof originalText !== 'string' ||
        !originalText.trim() ||
        !Number.isSafeInteger(startOffset) ||
        !Number.isSafeInteger(endOffset) ||
        startOffset < 0 ||
        endOffset <= startOffset ||
        endOffset > extractedText.length
      ) {
        await connection.rollback();

        return res.status(400).json({
          success: false,
          message: `La asociación número ${i + 1} contiene datos no válidos.`
        });
      }

      // Comprobar que el texto seleccionado coincide con el documento
      const actualText = extractedText.slice(startOffset, endOffset);

      if (actualText !== originalText) {
        await connection.rollback();

        return res.status(400).json({
          success: false,
          message: `El texto de la asociación número ${i + 1} no coincide con el documento.`
        });
      }

      // Comprobar que el campo pertenece a esta plantilla
      const [fields]: any = await connection.execute(
        `
        SELECT id
        FROM template_fields
        WHERE id = ? AND template_id = ?
        LIMIT 1
        `,
        [fieldId, templateId]
      );

      if (fields.length === 0) {
        await connection.rollback();

        return res.status(400).json({
          success: false,
          message: `El campo de la asociación número ${i + 1} no pertenece a esta plantilla.`
        });
      }

      validatedMappings.push({
        template_field_id: fieldId,
        original_text: originalText,
        start_offset: startOffset,
        end_offset: endOffset
      });
    }

    // Ordenar y comprobar que no existan selecciones superpuestas
    const orderedMappings = [...validatedMappings].sort(
      (a, b) => a.start_offset - b.start_offset
    );

    for (let i = 1; i < orderedMappings.length; i++) {
      if (
        orderedMappings[i].start_offset <
        orderedMappings[i - 1].end_offset
      ) {
        await connection.rollback();

        return res.status(400).json({
          success: false,
          message: 'Existen asociaciones que se superponen.'
        });
      }
    }

    // Eliminar las asociaciones anteriores de esta plantilla
    await connection.execute(
      `
      DELETE tfm
      FROM template_field_mappings tfm
      INNER JOIN template_fields tf
        ON tf.id = tfm.template_field_id
      WHERE tf.template_id = ?
      `,
      [templateId]
    );

    // Guardar las asociaciones nuevas
    for (const mapping of validatedMappings) {
      await connection.execute(
        `
        INSERT INTO template_field_mappings
        (
          template_field_id,
          original_text,
          start_offset,
          end_offset
        )
        VALUES (?, ?, ?, ?)
        `,
        [
          mapping.template_field_id,
          mapping.original_text,
          mapping.start_offset,
          mapping.end_offset
        ]
      );
    }

    await connection.commit();

    return res.json({
      success: true,
      message: 'Asociaciones guardadas correctamente.',
      mappings_count: validatedMappings.length
    });

  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => undefined);
    }

    console.error('Error al guardar asociaciones:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudieron guardar las asociaciones.'
    });

  } finally {
    connection?.release();
  }
});


/* OBTENER ASOCIACIONES DE UNA PLANTILLA */
router.get('/:id/mappings', async (req, res) => {
  try {
    const templateId = Number(req.params.id);
    const userId = res.locals.userId;

    if (!Number.isSafeInteger(templateId) || templateId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'El ID de la plantilla no es válido.'
      });
    }

    // Verificar que la plantilla pertenece al usuario autenticado.
    const [templates]: any = await pool.query(
      `SELECT id
       FROM templates
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [templateId, userId]
    );

    if (templates.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No se encontró la plantilla.'
      });
    }

    // Obtener todas las asociaciones de sus campos.
    const [mappings]: any = await pool.query(
      `SELECT
          m.id,
          m.template_field_id,
          tf.field_key,
          tf.label AS field_label,
          m.original_text,
          m.start_offset,
          m.end_offset
       FROM template_field_mappings m
       INNER JOIN template_fields tf
          ON tf.id = m.template_field_id
       WHERE tf.template_id = ?
       ORDER BY m.start_offset ASC, m.id ASC`,
      [templateId]
    );

    return res.json({
      success: true,
      mappings
    });

  } catch (error) {
    console.error('Error al obtener asociaciones:', error);

    return res.status(500).json({
      success: false,
      message: 'Error al obtener las asociaciones de la plantilla.'
    });
  }
});


/* EDITAR TEMPLATE */
router.put('/:id', async (req, res) => {
  let connection;

  try {
    const templateId :any = Number(req.params.id);
    const userId = res.locals.userId;

    const { title, fields } = req.body;

    // Validar identificador
    if (!Number.isSafeInteger(templateId) || templateId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'El ID de la plantilla no es válido.'
      });
    }

    // Validar nombre
    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.trim().length > 180
    ) {
      return res.status(400).json({
        success: false,
        message: 'El nombre debe tener entre 1 y 180 caracteres.'
      });
    }

    // Validar lista de campos
    if (!Array.isArray(fields) || fields.length > 100) {
      return res.status(400).json({
        success: false,
        message: 'La lista de campos no es válida o supera el límite de 100.'
      });
    }

    const allowedTypes = [
      'text',
      'textarea',
      'number',
      'date',
      'email',
      'phone'
    ];

    const usedKeys = new Set<string>();
    const usedIds = new Set<number>();

    // Validar campos recibidos
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i] as TemplateFieldUpdate;

      if (
        !field ||
        (field.id !== undefined &&
          (!Number.isSafeInteger(field.id) || field.id <= 0)) ||
        typeof field.field_key !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(field.field_key) ||
        typeof field.label !== 'string' ||
        !field.label.trim() ||
        field.label.trim().length > 150 ||
        typeof field.field_type !== 'string' ||
        !allowedTypes.includes(field.field_type) ||
        typeof field.required !== 'boolean' ||
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
          message: `El campo número ${i + 1} contiene datos no válidos.`
        });
      }

      if (usedKeys.has(field.field_key)) {
        return res.status(400).json({
          success: false,
          message: `La clave "${field.field_key}" está repetida.`
        });
      }

      usedKeys.add(field.field_key);

      if (field.id !== undefined) {
        if (usedIds.has(field.id)) {
          return res.status(400).json({
            success: false,
            message: `El ID del campo ${field.id} está repetido.`
          });
        }

        usedIds.add(field.id);
      }
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Comprobar que la plantilla pertenece al usuario
    const [templates]: any = await connection.execute(
      `SELECT id
       FROM templates
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [templateId, userId]
    );

    if (templates.length === 0) {
      await connection.rollback();

      return res.status(404).json({
        success: false,
        message: 'Plantilla no encontrada.'
      });
    }

    // Obtener los campos existentes y bloquearlos durante la transacción
    const [existingFields]: any = await connection.execute(
      `SELECT id
       FROM template_fields
       WHERE template_id = ?
       FOR UPDATE`,
      [templateId]
    );

    const existingIds = new Set<number>(
      existingFields.map((field: any) => Number(field.id))
    );

    // Verificar que los IDs recibidos pertenecen a esta plantilla
    for (const field of fields as TemplateFieldUpdate[]) {
      if (
        field.id !== undefined &&
        !existingIds.has(field.id)
      ) {
        await connection.rollback();

        return res.status(400).json({
          success: false,
          message: `El campo con ID ${field.id} no pertenece a esta plantilla.`
        });
      }
    }

    // Actualizar nombre de la plantilla
    await connection.execute(
      `UPDATE templates
       SET title = ?
       WHERE id = ? AND user_id = ?`,
      [title.trim(), templateId, userId]
    );

    // Identificar los campos que deben conservarse
    const receivedIds = new Set(
      (fields as TemplateFieldUpdate[])
        .filter(field => field.id !== undefined)
        .map(field => field.id as number)
    );

    // Eliminar únicamente los campos que el usuario quitó
    for (const existingId of existingIds) {
      if (!receivedIds.has(existingId)) {
        await connection.execute(
          `DELETE FROM template_fields
           WHERE id = ? AND template_id = ?`,
          [existingId, templateId]
        );
      }
    }

    // Actualizar los campos existentes e insertar los nuevos
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i] as TemplateFieldUpdate;

      if (field.id !== undefined) {
        // Actualizar sin cambiar el ID
        await connection.execute(
          `UPDATE template_fields
           SET
             field_key = ?,
             label = ?,
             field_type = ?,
             required = ?,
             placeholder = ?,
             options_json = ?,
             sort_order = ?
           WHERE id = ? AND template_id = ?`,
          [
            field.field_key,
            field.label.trim(),
            field.field_type,
            field.required ? 1 : 0,
            field.placeholder ?? null,
            field.options_json ?? null,
            i,
            field.id,
            templateId
          ]
        );
      } else {
        // Insertar un campo nuevo
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
            i
          ]
        );
      }
    }

    await connection.commit();

    return res.json({
      success: true,
      message: 'Plantilla actualizada correctamente.',
      template: {
        id: templateId,
        title: title.trim(),
        fields_count: fields.length
      }
    });

  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => undefined);
    }

    console.error('Error al actualizar plantilla:', error);

    return res.status(500).json({
      success: false,
      message: 'No se pudo actualizar la plantilla.'
    });

  } finally {
    connection?.release();
  }
});

// Generar documento DOCX mediante asociaciones A2
router.post('/:id/generate', async (req, res) => {
  try {
    const templateId = Number(req.params.id);
    const userId = res.locals.userId;
    const values = req.body?.values;

    if (!Number.isSafeInteger(templateId) || templateId <= 0) {
      return res.status(400).json({
        success: false,
        message: 'El ID de la plantilla no es válido.'
      });
    }

    if (
      !values ||
      typeof values !== 'object' ||
      Array.isArray(values)
    ) {
      return res.status(400).json({
        success: false,
        message: 'Debes enviar los valores de los campos.'
      });
    }

    // 1. Obtener la plantilla y su documento original.
    const [templateRows]: any = await pool.query(
      `SELECT
         t.id,
         t.title,
         t.source_document_id,
         d.stored_name,
         d.file_extension,
         d.extracted_text
       FROM templates t
       INNER JOIN documents d
         ON d.id = t.source_document_id
       WHERE t.id = ?
         AND t.user_id = ?
       LIMIT 1`,
      [templateId, userId]
    );

    if (!templateRows.length) {
      return res.status(404).json({
        success: false,
        message: 'No se encontró la plantilla o no tienes acceso a ella.'
      });
    }

    const template = templateRows[0];

    const fileExtension = String(template.file_extension).toLowerCase().replace(/^\./, '');

    if (!['docx', 'pdf'].includes(fileExtension)) {
      return res.status(400).json({
        success: false,
        message: 'La generación está disponible para documentos DOCX y PDF.'
      });
    }

    if (!template.extracted_text) {
      return res.status(400).json({
        success: false,
        message: 'La plantilla no tiene texto extraído.'
      });
    }

    // 2. Obtener únicamente los campos asociados de la plantilla.
    const [fieldRows]: any = await pool.query(
      `
      SELECT
        tf.id,
        tf.field_key,
        tf.label,
        tf.required
      FROM template_fields tf
      WHERE tf.template_id = ?
        AND EXISTS (
          SELECT 1
          FROM template_field_mappings tfm
          WHERE tfm.template_field_id = tf.id
        )
      ORDER BY tf.sort_order ASC, tf.id ASC
      `,
      [templateId]
    );

    if (!fieldRows.length) {
      return res.status(400).json({
        success: false,
        message: 'La plantilla todavía no tiene campos asociados al documento.'
      });
    }

    // 3. Validar los campos obligatorios.
    for (const field of fieldRows) {
      const value = values[field.field_key];

      if (
        Number(field.required) === 1 &&
        (value === undefined ||
          value === null ||
          String(value).trim() === '')
      ) {
        return res.status(400).json({
          success: false,
          message: `El campo "${field.label}" es obligatorio.`
        });
      }
    }

    // 4. Obtener las asociaciones A2.
    const [mappingRows]: any = await pool.query(
      `SELECT
         m.template_field_id,
         m.original_text,
         m.start_offset,
         m.end_offset,
         f.field_key
       FROM template_field_mappings m
       INNER JOIN template_fields f
         ON f.id = m.template_field_id
       WHERE f.template_id = ?
       ORDER BY m.start_offset ASC`,
      [templateId]
    );

    if (!mappingRows.length) {
      return res.status(400).json({
        success: false,
        message: 'La plantilla todavía no tiene asociaciones de texto.'
      });
    }

    // 5. Preparar los reemplazos.
    const mappings = mappingRows.map((mapping: any) => ({
      original_text: mapping.original_text,
      start_offset: Number(mapping.start_offset),
      end_offset: Number(mapping.end_offset),
      value: values[mapping.field_key] ?? ''
    }));

    // 6. Localizar el DOCX original.
    const templatePath = path.resolve(
      process.cwd(),
      'uploads',
      'documents',
      template.stored_name
    );

    // 7. Generar el nuevo documento.
    const outputDirectory = path.resolve(
      process.cwd(),
      'uploads',
      'generated'
    );

    const result =
    fileExtension === 'pdf'? await generatePdfFromMappings({
      templatePath,
      outputDirectory,
      extractedText: template.extracted_text,
      mappings
    }) : await generateDocxFromMappings({
      templatePath,
      outputDirectory,
      extractedText: template.extracted_text,
      mappings
    });

    // 8. Registrar el documento generado en MySQL.
    const storagePath = path.relative(
      process.cwd(),
      result.filePath
    );

    await pool.execute(
      `
      INSERT INTO generated_documents
      (
        user_id,
        template_id,
        output_filename,
        output_format,
        storage_path,
        form_data,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        userId,
        templateId,
        result.fileName,
        fileExtension,
        storagePath,
        JSON.stringify(values),
        'completed'
      ]
    );

    // 9. Devolver el DOCX al usuario.
    return res.download(
      result.filePath,
      result.fileName,
      (error) => {
        if (error) {
          console.error(
            'Error al descargar el documento generado:',
            error
          );

          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              message: 'No se pudo descargar el documento generado.'
            });
          }
        }
      }
    );

  } catch (error) {
    console.error('Error al generar documento A2:', error);

    return res.status(500).json({
      success: false,
      message:
        error instanceof Error
          ? error.message
          : 'Ocurrió un error al generar el documento.'
    });
  }
});

// GET /api/templates/dashboard/recent-activity
router.get('/dashboard/recent-activity', async (req, res) => {
  try {
    const userId = res.locals.userId;

    const [rows]: any = await pool.query(
      `
      SELECT *
      FROM (
        SELECT
          id,
          'document' AS type,
          original_name AS title,
          status,
          created_at
        FROM documents
        WHERE user_id = ?

        UNION ALL

        SELECT
          id,
          'template' AS type,
          title,
          status,
          created_at
        FROM templates
        WHERE user_id = ?

        UNION ALL

        SELECT
          id,
          'generated' AS type,
          output_filename AS title,
          status,
          created_at
        FROM generated_documents
        WHERE user_id = ?
      ) AS activity
      ORDER BY created_at DESC
      LIMIT 6
      `,
      [userId, userId, userId]
    );

    return res.json({
      success: true,
      activity: rows
    });

  } catch (error) {
    console.error(
      'Error al obtener actividad reciente:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'No se pudo obtener la actividad reciente.'
    });
  }
});
export default router;
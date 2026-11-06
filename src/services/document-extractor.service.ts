import fs from 'node:fs/promises';
import path from 'node:path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const uploadDirectory = path.resolve(
  process.cwd(),
  'uploads',
  'documents'
);

export async function extractDocumentText(
  storedName: string,
  fileExtension: string
): Promise<string> {
  // Evitar que el nombre permita acceder a otros directorios.
  if (!storedName || path.basename(storedName) !== storedName) {
    throw new Error('Nombre de archivo no válido.');
  }

  const filePath = path.resolve(uploadDirectory, storedName);

  if (path.dirname(filePath) !== uploadDirectory) {
    throw new Error('La ruta del documento no es válida.');
  }

  const buffer = await fs.readFile(filePath);
  const extension = fileExtension.toLowerCase().replace(/^\./, '');

  let extractedText = '';

  if (extension === 'pdf') {
    const result = await pdfParse(buffer);
    extractedText = result.text;
  } else if (extension === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    extractedText = result.value;
  } else {
    throw new Error(
      'La extracción automática está disponible para PDF y DOCX. Las imágenes requieren OCR.'
    );
  }

  extractedText = extractedText.trim();

  if (!extractedText) {
    throw new Error(
      'El documento no contiene texto extraíble o necesita OCR.'
    );
  }

  return extractedText;
}
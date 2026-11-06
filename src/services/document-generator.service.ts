
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';

interface GenerateDocxParams {
  templatePath: string;
  outputDirectory: string;
  data: Record<string, string | number | boolean>;
}

interface GenerateDocxResult {
  fileName: string;
  filePath: string;
}

export async function generateDocxDocument({
  templatePath,
  outputDirectory,
  data
}: GenerateDocxParams): Promise<GenerateDocxResult> {

  // 1. Comprobar que el archivo original existe.
  await fs.access(templatePath);

  // 2. Comprobar que sea un documento Word DOCX.
  if (path.extname(templatePath).toLowerCase() !== '.docx') {
    throw new Error('Solo se pueden generar documentos DOCX.');
  }

  // 3. Leer el documento original.
  const content = await fs.readFile(templatePath);

  // 4. Cargar el archivo DOCX.
  const zip = new PizZip(content);

  // 5. Preparar el motor de plantillas.
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true
  });

  // 6. Reemplazar los marcadores con los valores recibidos.
  doc.render(data);

  // 7. Generar el nuevo documento Word.
  const buffer = doc.getZip().generate({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  });

  // 8. Crear la carpeta de salida si no existe.
  await fs.mkdir(outputDirectory, { recursive: true });

  // 9. Asignar un nombre único al documento generado.
  const fileName = `${randomUUID()}.docx`;
  const filePath = path.join(outputDirectory, fileName);

  // 10. Guardar el documento generado.
  await fs.writeFile(filePath, buffer);

  return {
    fileName,
    filePath
  };
}

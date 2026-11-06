
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import PizZip from 'pizzip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const WORD_NS =
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

interface A2Mapping {
  original_text: string;
  start_offset: number;
  end_offset: number;
  value: string | number | boolean;
}

interface GenerateA2Params {
  templatePath: string;
  outputDirectory: string;
  extractedText: string;
  mappings: A2Mapping[];
}

interface TextPart {
  node: any;
  text: string;
  globalStart: number;
}

interface TextSegment {
  node: any;
  localStart: number;
  localEnd: number;
  length: number;
}

interface GenerateA2Result {
  fileName: string;
  filePath: string;
}

function collectParagraphParts(paragraph: any): {
  text: string;
  parts: Array<{ node: any | null; text: string }>;
} {
  const parts: Array<{ node: any | null; text: string }> = [];

  function visit(node: any): void {
    for (
      let child = node.firstChild;
      child;
      child = child.nextSibling
    ) {
      if (child.nodeType !== 1) {
        continue;
      }

      if (child.namespaceURI === WORD_NS) {
        if (child.localName === 't') {
          parts.push({
            node: child,
            text: child.textContent ?? ''
          });
          continue;
        }

        if (child.localName === 'tab') {
          parts.push({ node: null, text: '\t' });
          continue;
        }

        if (child.localName === 'br' || child.localName === 'cr') {
          parts.push({ node: null, text: '\n' });
          continue;
        }
      }

      visit(child);
    }
  }

  visit(paragraph);

  return {
    text: parts.map(part => part.text).join(''),
    parts
  };
}

function buildTextParts(
  xmlDocument: any,
  extractedText: string
): TextPart[] {
  const paragraphs = xmlDocument.getElementsByTagNameNS(
    WORD_NS,
    'p'
  );

  const textParts: TextPart[] = [];
  let searchPosition = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs.item(i);
    const collected = collectParagraphParts(paragraph);

    if (!collected.text) {
      continue;
    }

    const leadingWhitespace =
      collected.text.length - collected.text.trimStart().length;

    const normalizedParagraph = collected.text.trim();

    const paragraphStart = extractedText.indexOf(
      normalizedParagraph,
      searchPosition
    );

    if (paragraphStart === -1) {
      const foundAnywhere = extractedText.indexOf(
        normalizedParagraph
      );

      throw new Error(
        `No se pudo sincronizar el párrafo ${i + 1}. ` +
        `Texto: "${normalizedParagraph}". ` +
        `Posición global: ${foundAnywhere}. ` +
        `Posición de búsqueda: ${searchPosition}.`
      );
    }

    let localPosition = 0;

    for (const part of collected.parts) {
      if (part.node && part.text.length > 0) {
        textParts.push({
          node: part.node,
          text: part.text,
          globalStart:
            paragraphStart + localPosition - leadingWhitespace
        });
      }

      localPosition += part.text.length;
    }

    searchPosition = paragraphStart + normalizedParagraph.length;
  }

  return textParts;
}

function setNodeText(node: any, value: string): void {
  node.textContent = value;

  if (/^\s|\s$/.test(value)) {
    node.setAttributeNS(XML_NS, 'xml:space', 'preserve');
  }
}

function replaceMapping(
  mapping: A2Mapping,
  extractedText: string,
  textParts: TextPart[]
): void {
  const { start_offset, end_offset, original_text } = mapping;

  if (
    !Number.isInteger(start_offset) ||
    !Number.isInteger(end_offset) ||
    start_offset < 0 ||
    end_offset <= start_offset ||
    end_offset > extractedText.length
  ) {
    throw new Error(
      'Una asociación contiene posiciones inválidas.'
    );
  }

  const actualText = extractedText.slice(
    start_offset,
    end_offset
  );

  if (actualText !== original_text) {
    throw new Error(
      `La asociación "${original_text}" ya no coincide con el texto extraído.`
    );
  }

  const segments: TextSegment[] = [];

  for (const part of textParts) {
    const partStart = part.globalStart;
    const partEnd = partStart + part.text.length;

    const overlapStart = Math.max(start_offset, partStart);
    const overlapEnd = Math.min(end_offset, partEnd);

    if (overlapStart < overlapEnd) {
      segments.push({
        node: part.node,
        localStart: overlapStart - partStart,
        localEnd: overlapEnd - partStart,
        length: overlapEnd - overlapStart
      });
    }
  }

  const coveredLength = segments.reduce(
    (total, segment) => total + segment.length,
    0
  );

  if (coveredLength !== end_offset - start_offset) {
    throw new Error(
      `La asociación "${original_text}" atraviesa un salto de párrafo o una zona que todavía no se puede reemplazar. Selecciona el texto dentro de un mismo párrafo.`
    );
  }

  const replacement = String(mapping.value ?? '');

  segments.forEach((segment, index) => {
    const currentText = segment.node.textContent ?? '';

    const before = currentText.slice(0, segment.localStart);
    const after = currentText.slice(segment.localEnd);

    setNodeText(
      segment.node,
      index === 0
        ? before + replacement + after
        : before + after
    );
  });
}

export async function generateDocxFromMappings({
  templatePath,
  outputDirectory,
  extractedText,
  mappings
}: GenerateA2Params): Promise<GenerateA2Result> {
  await fs.access(templatePath);

  if (path.extname(templatePath).toLowerCase() !== '.docx') {
    throw new Error(
      'Solo se pueden generar documentos DOCX.'
    );
  }

  if (!mappings.length) {
    throw new Error(
      'La plantilla todavía no tiene asociaciones de texto.'
    );
  }

  const content = await fs.readFile(templatePath);
  const zip = new PizZip(content);

  const documentFile = zip.file('word/document.xml');

  if (!documentFile) {
    throw new Error(
      'No se encontró el contenido principal del documento Word.'
    );
  }

  const xml = documentFile.asText();

  const xmlDocument = new DOMParser().parseFromString(
    xml,
    'application/xml'
  );

  if (
    !xmlDocument.documentElement ||
    xmlDocument.getElementsByTagName('parsererror').length > 0
  ) {
    throw new Error(
      'No se pudo interpretar el XML del documento Word.'
    );
  }

  const textParts = buildTextParts(
    xmlDocument,
    extractedText
  );

  const orderedMappings = [...mappings].sort(
    (a, b) => b.start_offset - a.start_offset
  );

  for (const mapping of orderedMappings) {
    replaceMapping(
      mapping,
      extractedText,
      textParts
    );
  }

  const updatedXml = new XMLSerializer().serializeToString(
    xmlDocument
  );

  zip.file('word/document.xml', updatedXml);

  await fs.mkdir(outputDirectory, { recursive: true });

  const fileName = `${randomUUID()}.docx`;
  const filePath = path.join(outputDirectory, fileName);

  const buffer = zip.generate({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  });

  await fs.writeFile(filePath, buffer);

  return {
    fileName,
    filePath
  };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  PDFDocument,
  StandardFonts,
  rgb
} from 'pdf-lib';

interface PdfA2Mapping {
  original_text: string;
  start_offset: number;
  end_offset: number;
  value: string | number | boolean;
}

interface GeneratePdfParams {
  templatePath: string;
  outputDirectory: string;
  extractedText: string;
  mappings: PdfA2Mapping[];
}

interface PdfTextItem {
  pageIndex: number;
  text: string;
  start: number;
  end: number;
  x: number;
  y: number;
  width: number;
  height: number;
  direction: string;
  fontName: string;
  transform: number[];
  bold: boolean;
  italic: boolean;
}

interface PdfMappingSegment {
  item: PdfTextItem;
  localStart: number;
  localEnd: number;
  x: number;
  width: number;
}

interface GeneratePdfResult {
  fileName: string;
  filePath: string;
}

/**
 * Obtiene los textos del PDF y relaciona cada fragmento
 * con su posición dentro del documento extraído.
 */
async function extractPdfTextPositions(
  buffer: Buffer,
  extractedText: string
): Promise<PdfTextItem[]> {
  const pdfjs: any = await import(
    'pdfjs-dist/legacy/build/pdf.mjs'
  );

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false
  });

  const pdf = await loadingTask.promise;

  const items: PdfTextItem[] = [];

  let searchPosition = 0;

  try {
    for (
      let pageNumber = 1;
      pageNumber <= pdf.numPages;
      pageNumber++
    ) {
      const page = await pdf.getPage(pageNumber);

      const textContent = await page.getTextContent();

      // Cargamos los objetos gráficos y las fuentes de la página.
      await page.getOperatorList();

      // Identificamos las fuentes utilizadas en esta página.
      const fontNames: string[] = [
        ...new Set<string>(
          textContent.items
            .filter((item: any) => typeof item.fontName === 'string')
            .map((item: any) => item.fontName as string)
        )
      ];

      // Guardamos los estilos de las fuentes utilizadas en esta página.
      const fontStyles = new Map<
      string,
      { bold: boolean; italic: boolean }
      >();

      for (const fontName of fontNames) {
      try {
        const fontObject = page.commonObjs.get(fontName);

        const style = {
          bold: fontObject?.bold === true,
          italic: fontObject?.italic === true
        };

        fontStyles.set(fontName, style);

        console.log('ESTILO DE FUENTE DETECTADO:', {
          fontName,
          loadedName: fontObject?.loadedName,
          ...style
        });

      } catch (error) {
        console.log('NO SE PUDO RECUPERAR LA FUENTE:', {
          fontName,
          error
        });

        fontStyles.set(fontName, {
          bold: false,
          italic: false
        });
      }
      }
      for (const textItem of textContent.items) {
        if (
          !textItem.str ||
          typeof textItem.str !== 'string' ||
          !textItem.str.trim()
        ) {
          continue;
        }

        const text = textItem.str;

        const normalizedExtracted = normalizePdfText(
          extractedText
        );
        
        const normalizedItem = normalizePdfText(text);
        
        if (!normalizedItem.text.length) {
          continue;
        }
        
        const occurrences: Array<{
          start: number;
          end: number;
        }> = [];
        
        let currentPosition = 0;
        
        while (true) {
          const foundPosition = normalizedExtracted.text.indexOf(
            normalizedItem.text,
            currentPosition
          );
        
          if (foundPosition === -1) {
            break;
          }
        
          const originalStart =
            normalizedExtracted.offsets[foundPosition];
        
          const lastNormalizedPosition =
            foundPosition + normalizedItem.text.length - 1;
        
          const originalEnd =
            normalizedExtracted.offsets[lastNormalizedPosition] + 1;
        
          occurrences.push({
            start: originalStart,
            end: originalEnd
          });
        
          currentPosition = foundPosition + 1;
        }
        
        if (!occurrences.length) {
          throw new Error(
            `No se pudo sincronizar el fragmento "${text}". ` +
            `Texto extraído cercano: "${extractedText.slice(
              Math.max(0, searchPosition - 40),
              Math.min(extractedText.length, searchPosition + 100)
            )}".`
          );
        }
        
        const selectedOccurrence = occurrences.reduce(
          (closest, occurrence) => {
            return Math.abs(occurrence.start - searchPosition) <
              Math.abs(closest.start - searchPosition)
              ? occurrence
              : closest;
          }
        );
        
        const start = selectedOccurrence.start;
        const end = selectedOccurrence.end;

        const transform = textItem.transform;

        const x = Number(transform[4]);
        const y = Number(transform[5]);

        const width = Math.abs(Number(textItem.width));

        const height =
          Math.abs(Number(textItem.height)) ||
          Math.abs(Number(transform[3]));

        if (
          !Number.isFinite(x) ||
          !Number.isFinite(y) ||
          !Number.isFinite(width) ||
          !Number.isFinite(height) ||
          width <= 0 ||
          height <= 0
        ) {
          throw new Error(
            'El PDF contiene un fragmento de texto con coordenadas inválidas.'
          );
        }

        const fontStyle = fontStyles.get(textItem.fontName) ?? {
          bold: false,
          italic: false
        };

        items.push({
          pageIndex: pageNumber - 1,
          text,
          start,
          end,
          x,
          y,
          width,
          height,
          direction: textItem.dir || 'ltr',
          fontName: textItem.fontName || '',
          transform: [...textItem.transform],
          bold: fontStyle.bold,
          italic: fontStyle.italic
        });

        searchPosition = Math.max(
          searchPosition,
          end
        );
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  if (!items.length) {
    throw new Error(
      'No se pudieron localizar textos dentro del PDF.'
    );
  }

  return items;
}

function normalizePdfText(value: string): {
  text: string;
  offsets: number[];
} {
  let normalized = '';
  const offsets: number[] = [];

  for (let i = 0; i < value.length; i++) {
    const character = value[i];

    // Ignorar espacios, tabulaciones y saltos de línea.
    if (/\s/.test(character)) {
      continue;
    }

    normalized += character;
    offsets.push(i);
  }

  return {
    text: normalized,
    offsets
  };
}

/**
 * Localiza los fragmentos que corresponden a una asociación A2.
 */

function locateMappingSegments(
  mapping: PdfA2Mapping,
  extractedText: string,
  textItems: PdfTextItem[]
): PdfMappingSegment[] {
  const {
    original_text,
    start_offset,
    end_offset
  } = mapping;

  if (
    !Number.isInteger(start_offset) ||
    !Number.isInteger(end_offset) ||
    start_offset < 0 ||
    end_offset <= start_offset ||
    end_offset > extractedText.length
  ) {
    throw new Error(
      'Una asociación PDF contiene posiciones inválidas.'
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

  const segments: PdfMappingSegment[] = [];

  const covered = new Array(
    end_offset - start_offset
  ).fill(false);

  for (const item of textItems) {
    const overlapStart = Math.max(
      start_offset,
      item.start
    );

    const overlapEnd = Math.min(
      end_offset,
      item.end
    );

    if (overlapStart >= overlapEnd) {
      continue;
    }

    if (item.direction !== 'ltr') {
      throw new Error(
        'Por ahora, la generación PDF A2 admite textos de izquierda a derecha.'
      );
    }

    let localStart = overlapStart - item.start;
    let localEnd = overlapEnd - item.start;

    // Si el campo seleccionado contiene únicamente guiones bajos,
    // ampliar la cobertura hasta incluir toda la secuencia.
    if (/^[_\s]+$/.test(actualText)) {
      while (
        localStart > 0 &&
        item.text[localStart - 1] === '_'
      ) {
        localStart--;
      }

      while (
        localEnd < item.text.length &&
        item.text[localEnd] === '_'
      ) {
        localEnd++;
      }
    }

    const characterWidth =
      item.width / item.text.length;

    const x =
      item.x + localStart * characterWidth;

    const selectedItemText = item.text.slice(
      localStart,
      localEnd
    );

    // Si seleccionamos espacios y guiones bajos al final
    // del elemento, cubrir hasta su extremo real.
    const isTrailingBlank =
      /^[_\s]+$/.test(selectedItemText) &&
      localEnd === item.text.length;

    const width = isTrailingBlank
      ? item.x + item.width - x
      : (localEnd - localStart) * characterWidth;

    segments.push({
      item,
      localStart,
      localEnd,
      x,
      width
    });

    for (
      let position = overlapStart;
      position < overlapEnd;
      position++
    ) {
      covered[position - start_offset] = true;
    }
  }

  if (!segments.length) {
    throw new Error(
      `No se encontró el texto "${original_text}" en las posiciones del PDF.`
    );
  }

  // Los espacios pueden estar separados de los elementos de texto.
  for (let i = 0; i < covered.length; i++) {
    const character = actualText[i];

    if (!covered[i] && !/\s/.test(character)) {
      throw new Error(
        `No se pudo localizar completamente la asociación "${original_text}" dentro del PDF.`
      );
    }
  }

  // Permitir varias líneas, pero no asociaciones que abarquen
  // páginas diferentes.
  const firstPageIndex = segments[0].item.pageIndex;

  for (const segment of segments) {
    if (segment.item.pageIndex !== firstPageIndex) {
      throw new Error(
        `La asociación "${original_text}" ocupa varias páginas. ` +
        'Selecciona el texto dentro de una sola página.'
      );
    }
  }

  return segments;
}


/**
 * Cubre el texto original e inserta su nuevo valor.
 */

/**
 * Cubre el texto original e inserta su nuevo valor.
 */
function replacePdfMapping(
  pdfPage: any,
  fonts: {
    normal: any;
    bold: any;
    italic: any;
    boldItalic: any;
  },
  mapping: PdfA2Mapping,
  segments: PdfMappingSegment[]
): void {
  const firstSegment = segments[0];
  const firstItem = firstSegment.item;

  const font =
  firstItem.bold && firstItem.italic
    ? fonts.boldItalic
    : firstItem.bold
      ? fonts.bold
      : firstItem.italic
        ? fonts.italic
        : fonts.normal;

  // Calculamos las posiciones de cada fragmento.
  const geometries = segments.map(segment => {
    const item = segment.item;

    const sourceFontSize =
      Math.abs(item.transform?.[0] ?? 0) || item.height;

    const measuredTotalWidth = font.widthOfTextAtSize(
      item.text,
      sourceFontSize
    );

    const scale = measuredTotalWidth > 0
      ? item.width / measuredTotalWidth
      : 1;

    const prefix = item.text.slice(0, segment.localStart);

    const selectedText = item.text.slice(
      segment.localStart,
      segment.localEnd
    );

    const prefixWidth =
      font.widthOfTextAtSize(prefix, sourceFontSize) * scale;

    const selectedWidth =
      font.widthOfTextAtSize(selectedText, sourceFontSize) * scale;

    const x = item.x + prefixWidth;

    const isTrailingBlank =
      /^[_\s]+$/.test(selectedText) &&
      segment.localEnd === item.text.length;

    const width = isTrailingBlank
      ? item.x + item.width - x
      : selectedWidth;

    return {
      segment,
      x,
      width,
      isBlank: /^[_\s]+$/.test(selectedText)
    };
  });

  const minX = Math.min(...geometries.map(g => g.x));

  const maxX = Math.max(
    ...geometries.map(g => g.x + g.width)
  );

  const availableWidth = maxX - minX;

  if (availableWidth <= 0) {
    throw new Error(
      'No se pudo calcular el espacio disponible para el reemplazo.'
    );
  }

  // Cubrimos cada fragmento una sola vez.
  for (const geometry of geometries) {
    const item = geometry.segment.item;

    // No agregamos margen horizontal a los campos de guiones.
    const paddingX = geometry.isBlank ? 0 : 3;
    const paddingY = item.height * 0.25;

    pdfPage.drawRectangle({
      x: geometry.x - paddingX,
      y: item.y - paddingY,
      width: geometry.width + paddingX * 2,
      height: item.height + paddingY * 2,
      color: rgb(1, 1, 1),
      borderWidth: 0
    });
  }

  const replacement = String(mapping.value ?? '')
    .replace(/\r?\n/g, ' ');

  if (!replacement.trim()) {
    return;
  }

  const originalFontSize =
  Math.abs(firstItem.transform?.[0] ?? 0) ||
  firstItem.height;

  let fontSize = Math.max(
    4,
    Math.min(72, originalFontSize)
  );

  const minimumFontSize = 4;

  while (
    font.widthOfTextAtSize(replacement, fontSize) > availableWidth &&
    fontSize > minimumFontSize
  ) {
    fontSize -= 0.25;
  }

  const replacementWidth = font.widthOfTextAtSize(
    replacement,
    fontSize
  );

  if (replacementWidth > availableWidth + 0.5) {
    throw new Error(
      `El texto "${replacement}" es demasiado largo para el espacio disponible en el PDF.`
    );
  }

  pdfPage.drawText(replacement, {
    x: minX,
    y: firstItem.y,
    size: fontSize,
    font,
    color: rgb(0, 0, 0)
  });
}

/**
 * Genera un PDF nuevo mediante las asociaciones A2.
 */
export async function generatePdfFromMappings({
  templatePath,
  outputDirectory,
  extractedText,
  mappings
}: GeneratePdfParams): Promise<GeneratePdfResult> {
  await fs.access(templatePath);

  if (
    path.extname(templatePath).toLowerCase() !== '.pdf'
  ) {
    throw new Error(
      'Solo se pueden generar documentos PDF.'
    );
  }

  if (!mappings.length) {
    throw new Error(
      'La plantilla todavía no tiene asociaciones de texto.'
    );
  }

  if (!extractedText.trim()) {
    throw new Error(
      'La plantilla no tiene texto extraído.'
    );
  }

  const originalBuffer = await fs.readFile(
    templatePath
  );

  // Leer posiciones de los textos originales.
  const textItems = await extractPdfTextPositions(
    originalBuffer,
    extractedText
  );

  // Abrir el PDF original sin reconstruir sus páginas.
  const pdfDocument = await PDFDocument.load(
    originalBuffer
  );

    const pages = pdfDocument.getPages();

    const fonts = {
    normal: await pdfDocument.embedFont(
      StandardFonts.Helvetica
    ),

    bold: await pdfDocument.embedFont(
      StandardFonts.HelveticaBold
    ),

    italic: await pdfDocument.embedFont(
      StandardFonts.HelveticaOblique
    ),

    boldItalic: await pdfDocument.embedFont(
      StandardFonts.HelveticaBoldOblique
    )
  };

  // Validar y localizar todas las asociaciones antes de modificar.
  const preparedMappings = mappings.map(mapping => {
    const segments = locateMappingSegments(
      mapping,
      extractedText,
      textItems
    );

    return {
      mapping,
      segments
    };
  });

  // Evitar que dos asociaciones intenten modificar el mismo espacio.
  const orderedMappings = [...preparedMappings].sort(
    (a, b) =>
      b.mapping.start_offset -
      a.mapping.start_offset
  );

  for (const prepared of orderedMappings) {
    const pageIndex =
      prepared.segments[0].item.pageIndex;

    const page = pages[pageIndex];

    if (!page) {
      throw new Error(
        'No se encontró la página correspondiente a una asociación.'
      );
    }

    replacePdfMapping(
      page,
      fonts,
      prepared.mapping,
      prepared.segments
    );
  }

  // Guardar el documento generado.
  await fs.mkdir(outputDirectory, {
    recursive: true
  });

  const fileName = `${randomUUID()}.pdf`;

  const filePath = path.join(
    outputDirectory,
    fileName
  );

  const generatedBuffer = await pdfDocument.save();

  await fs.writeFile(
    filePath,
    generatedBuffer
  );

  return {
    fileName,
    filePath
  };
}
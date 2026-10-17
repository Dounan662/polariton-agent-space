/** Pure file classification shared by Markdown parsing and file-card rendering. */
import { classifyCodeFileType, type CodeFileType, type FileTypeProjectContext } from './code-file-types.ts'

/** File categories with distinct 28px glyphs. */
export type FileType =
  | CodeFileType
  | 'code'
  | 'excel'
  | 'folder'
  | 'html'
  | 'image'
  | 'markdown'
  | 'other'
  | 'pdf'
  | 'ppt'
  | 'video'
  | 'word'

/** Compatibility name for consumers that pass an already resolved category. */
export type FileTypeKind = FileType

type ClassifiedFileType = Exclude<FileType, 'folder'>

export type { CodeFileType, FileTypeProjectContext } from './code-file-types.ts'

const EXTENSION_TYPES: Readonly<Record<string, ClassifiedFileType>> = {
  scss: 'code',
  sass: 'code',
  less: 'code',
  vue: 'code',
  svelte: 'code',
  astro: 'code',
  bat: 'code',
  cmd: 'code',
  csv: 'excel',
  tsv: 'excel',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  tif: 'image',
  tiff: 'image',
  heic: 'image',
  heif: 'image',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  pdf: 'pdf',
  ppt: 'ppt',
  pptx: 'ppt',
  key: 'ppt',
  mp4: 'video',
  mov: 'video',
  m4v: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  mpg: 'video',
  mpeg: 'video',
  doc: 'word',
  docx: 'word',
  rtf: 'word',
  odt: 'word',
  pages: 'word',
  xls: 'excel',
  xlsx: 'excel',
  xlsm: 'excel',
  xlsb: 'excel',
  xlt: 'excel',
  xltx: 'excel',
  xltm: 'excel',
  ods: 'excel',
  ots: 'excel',
  fods: 'excel',
  numbers: 'excel',
}

const NAME_TYPES: Readonly<Record<string, ClassifiedFileType>> = {
  changelog: 'markdown',
  contributing: 'markdown',
  readme: 'markdown',
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/**
 * Extract the final suffix from a file path without changing its case.
 * A leading dot starts a suffix, while a missing or trailing dot returns an empty string.
 * @param path - File path or basename using either path separator.
 * @returns The characters after the basename's final dot.
 */
export function fileExtension(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1)
}

/**
 * Classify a file path or name for file-card presentation.
 * Matching is case-insensitive and applies code filename rules before extension rules;
 * unknown names fall back to `other`.
 * @param path - File path or basename using either path separator.
 * @param context - Optional project files used by context-sensitive code mappings.
 * @returns The file's closed presentation category.
 */
export function classifyFileType(
  path: string,
  context?: FileTypeProjectContext,
): ClassifiedFileType {
  const name = basename(path).toLowerCase()
  const extension = fileExtension(name).toLowerCase()
  return classifyCodeFileType(name, extension, context)
    ?? NAME_TYPES[name]
    ?? EXTENSION_TYPES[extension]
    ?? 'other'
}

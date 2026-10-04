import {
  File,
  FileCode2,
  FileJson,
  FileText,
  FileImage,
  FileTerminal,
  FileCog,
  FileLock2,
  Folder,
  FolderOpen,
  FileArchive,
  FileVideo,
  FileAudio,
  Database,
} from 'lucide-react';
import { extname, basename } from './paths';

const COLORS = {
  js: '#e8d44d',
  mjs: '#e8d44d',
  cjs: '#e8d44d',
  jsx: '#61dafb',
  ts: '#3b82f6',
  mts: '#3b82f6',
  tsx: '#61dafb',
  json: '#cbcb41',
  html: '#e44d26',
  htm: '#e44d26',
  css: '#42a5f5',
  scss: '#c6538c',
  less: '#2a4d80',
  md: '#7aa2f7',
  mdx: '#7aa2f7',
  py: '#4b8bbe',
  rb: '#cc342d',
  go: '#00add8',
  rs: '#dea584',
  java: '#e76f00',
  kt: '#a97bff',
  c: '#5c8dbc',
  h: '#a074c4',
  cpp: '#f34b7d',
  hpp: '#a074c4',
  cs: '#68217a',
  php: '#777bb3',
  swift: '#f05138',
  dart: '#00b4ab',
  lua: '#000080',
  sh: '#89e051',
  bash: '#89e051',
  ps1: '#012456',
  bat: '#c1f12e',
  yml: '#cb171e',
  yaml: '#cb171e',
  toml: '#9c4221',
  xml: '#e37933',
  svg: '#ffb13b',
  sql: '#e38c00',
  vue: '#41b883',
  svelte: '#ff3e00',
  env: '#ecd53f',
  lock: '#8a8a8a',
};

const CODE = new Set('js mjs cjs jsx ts mts tsx py rb go rs java kt c h cpp hpp cs php swift dart lua vue svelte html htm css scss less xml sql'.split(' '));
const IMAGE = new Set('png jpg jpeg gif webp svg ico bmp avif'.split(' '));

export function FileIcon({ name, size = 15 }) {
  const ext = extname(name);
  const base = basename(name).toLowerCase();
  const color = COLORS[ext] || (base.startsWith('.env') ? COLORS.env : '#9aa0a6');
  const props = { size, color, strokeWidth: 1.8, className: 'file-icon' };
  if (base === 'package.json' || base === 'tsconfig.json' || base.endsWith('rc') || base.endsWith('.config.js') || base.endsWith('.config.ts') || base === 'dockerfile') return <FileCog {...props} color={base === 'package.json' ? '#8bc34a' : color} />;
  if (ext === 'lock' || base.endsWith('-lock.json') || base.endsWith('.lock')) return <FileLock2 {...props} color={COLORS.lock} />;
  if (ext === 'json') return <FileJson {...props} />;
  if (IMAGE.has(ext)) return <FileImage {...props} color="#a074c4" />;
  if (['sh', 'bash', 'ps1', 'bat', 'cmd', 'zsh'].includes(ext)) return <FileTerminal {...props} />;
  if (['zip', 'gz', 'tar', '7z', 'rar'].includes(ext)) return <FileArchive {...props} />;
  if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return <FileVideo {...props} />;
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return <FileAudio {...props} />;
  if (['db', 'sqlite', 'sql'].includes(ext)) return <Database {...props} />;
  if (CODE.has(ext)) return <FileCode2 {...props} />;
  if (['md', 'mdx', 'txt', 'rst', 'log'].includes(ext)) return <FileText {...props} />;
  return <File {...props} />;
}

export function FolderIcon({ open, size = 15 }) {
  const Icon = open ? FolderOpen : Folder;
  return <Icon size={size} color="#8fa4c4" strokeWidth={1.8} className="file-icon" />;
}

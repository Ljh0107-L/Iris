// Icons: Lucide line icons, plus custom glyphs for filled stop square and file-type badges.
import {
  Activity, Archive, ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, Atom, BookOpen, Braces, Brain, BriefcaseBusiness,
  Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, Code, Copy, CornerDownLeft, Database,
  Download, Ellipsis, ExternalLink, File, FileCode, FileDiff, FileImage, FilePen, FileText, FoldVertical,
  Folder, FolderOpen, GitBranch, GitFork, Globe, Gauge, KeyRound, Laptop, Layers, ListChecks, ListTree,
  Maximize2, MessageCircleQuestion, MessageSquare, Minimize2, Moon, PanelLeft, PanelRight, Paperclip,
  Pencil, Plus, RefreshCw, Search, Server, Settings, ShieldAlert, ShieldCheck, SlidersHorizontal,
  SquareTerminal, StickyNote, Sun, Target, Terminal, Timer, Trash2, TriangleAlert, Unplug, Wifi, WrapText, Wrench,
  X, Zap, Infinity as InfinityIcon,
 Eye } from 'lucide-react';
import irisIcon from './assets/engines/iris.png';
import claudeCodeIcon from './assets/engines/claude-code.png';
import codexIcon from './assets/engines/codex.png';
import antigravityIcon from './assets/engines/antigravity.png';
import cursorIcon from './assets/engines/cursor.png';

const LUCIDE = {
  sun: Sun, moon: Moon, book: BookOpen, customize: BriefcaseBusiness,
  plus: Plus, search: Search, settings: Settings, terminal: SquareTerminal, laptop: Laptop, folder: Folder, folderOpen: FolderOpen,
  chevronDown: ChevronDown, chevronRight: ChevronRight, chevronUp: ChevronUp, caretDown: ChevronDown, caretRight: ChevronRight,
  check: Check, eye: Eye, arrowUp: ArrowUp, arrowUpRight: ArrowUpRight, panel: PanelRight,
  sidebar: PanelLeft, sidebarToggle: PanelLeft, prompt: Terminal, shield: ShieldCheck, shieldAlert: ShieldAlert,
  file: StickyNote, fileEdit: FilePen, x: X, alert: TriangleAlert, brain: Brain, refresh: RefreshCw, server: Server,
  key: KeyRound, trash: Trash2, edit: Pencil, globe: Globe, more: Ellipsis, archive: Archive, back: ChevronLeft,
  forward: ChevronRight, branch: GitBranch, enter: CornerDownLeft, compact: FoldVertical, copy: Copy, list: ListChecks,
  arrowLeft: ArrowLeft, unplug: Unplug, wifi: Wifi, question: MessageCircleQuestion, gauge: Gauge, database: Database,
  arrowDown: ArrowDown, timer: Timer, fileText: FileText, fileCode: FileCode, fileImage: FileImage, listTree: ListTree,
  externalLink: ExternalLink, code: Code, fileAny: File, maximize: Maximize2, minimize: Minimize2, paperclip: Paperclip,
  target: Target, fork: GitFork, fileDiff: FileDiff, terminalPanel: SquareTerminal, download: Download, chat: MessageSquare,
  console: Terminal, wrench: Wrench, wrap: WrapText, bolt: Zap, infinity: InfinityIcon,
  atom: Atom, braces: Braces, clock: Clock, activity: Activity, layers: Layers, sliders: SlidersHorizontal,
};

const GLYPHS = {
  stop: 'M8.5 7.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
};

export function Icon({ name, size = 16, stroke = 1.75, className, style }) {
  // The sidebar toggle is drawn here: a wide rounded window with a short tick, on an 18-unit grid.
  if (name === 'sidebarToggle') {
    return <svg className={className} style={style} width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true"><rect x="1.15" y="2.65" width="15.7" height="12.7" rx="3" /><path d="M5.1 6.2v5.6" /></svg>;
  }
  if (GLYPHS[name]) {
    return <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={GLYPHS[name]} /></svg>;
  }
  const Component = LUCIDE[name] ?? Ellipsis;
  return <Component className={className} style={style} size={size} strokeWidth={stroke} absoluteStrokeWidth={false} aria-hidden="true" />;
}

// Each engine is shown with its own icon: Claude's (for Claude Code), the Codex app's, the Antigravity app's and
// the Cursor app's (taken from those apps, cropped to the icon) — the vendors' marks, used only to say which engine a
// conversation runs on — and Iris's own, the app's icon, for Iris's agent.
const ENGINE_ICONS = { iris: irisIcon, 'claude-code': claudeCodeIcon, codex: codexIcon, antigravity: antigravityIcon, cursor: cursorIcon };
export function EngineLogo({ engine = 'iris', size = 16, className = '', title }) {
  return <img className={`engine-logo ${className}`} src={ENGINE_ICONS[engine] ?? irisIcon} width={size} height={size} alt={title ?? ''} aria-hidden={title ? undefined : 'true'} draggable={false} />;
}
// Iris's own mark: the >_ of the app icon in its rainbow, without the tile (the geometry of build/make-icon.py).
// On the welcome screen the underscore blinks, as a prompt's cursor does.
const MARK_STOPS = [[0, '#ff5e57'], [0.2, '#ff9500'], [0.38, '#ffcc00'], [0.56, '#34c759'], [0.76, '#0a84ff'], [1, '#af52de']];
export function IrisMark({ size = 56, className = '' }) {
  return <svg className={`iris-mark ${className}`} width={size} height={size} viewBox="10.25 10 28 28" fill="none" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <defs><linearGradient id="iris-mark-rainbow" gradientUnits="userSpaceOnUse" x1="0" y1="14.3" x2="0" y2="33.7">
      {MARK_STOPS.map(([offset, colour]) => <stop key={offset} offset={offset} stopColor={colour} />)}
    </linearGradient></defs>
    <path d="M14.5 16.5 22 24l-7.5 7.5" stroke="url(#iris-mark-rainbow)" />
    <path className="iris-mark-cursor" d="M25.5 31.5H34" stroke="url(#iris-mark-rainbow)" />
  </svg>;
}
// An engine's icon at the size of the welcome screen: an empty conversation shows which engine it runs on.
export const EngineMark = ({ engine, className = '' }) => <EngineLogo engine={engine} size={56} className={`engine-mark ${className}`} />;

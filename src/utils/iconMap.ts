import type { LucideIcon } from 'lucide-react';
import {
  FileText,
  BookOpen,
  FolderOpen,
  BarChart3,
  Brain,
  Download,
  Lightbulb,
  Search,
  MessageSquare,
  Pencil,
  Globe,
  Link,
  Sparkles,
  Dices,
  Plus,
  PenTool,
  Presentation,
  Table2,
  Code2,
  Wand2,
  ListChecks,
  Megaphone,
  MousePointerClick,
  Compass,
  Sun,
  Moon,
  FileSearch,
  LineChart,
  Workflow,
  Notebook,
  AlertTriangle,
  Folder,
  Calendar,
  Edit3,
  Tag,
  Mail,
  MessageCircle,
  Share2,
  ClipboardCheck,
  Send,
  FileDown,
  File as FileIcon,
  MessageCircleQuestion,
  ShieldCheck,
  ArrowDown,
  ArrowRight,
  Asterisk,
} from 'lucide-react';
import { WordIcon } from '../components/icons/BrandIcons';

type IconComponent = LucideIcon | typeof WordIcon;

const ICON_MAP: Record<string, IconComponent> = {
  // kebab-case (legacy)
  'file-text': FileText,
  'book-open': BookOpen,
  'folder-open': FolderOpen,
  'bar-chart-3': BarChart3,
  'brain': Brain,
  'download': Download,
  // PascalCase (PROMPT_CARDS)
  'FileText': FileText,
  'BookOpen': BookOpen,
  'FolderOpen': FolderOpen,
  'BarChart3': BarChart3,
  'Lightbulb': Lightbulb,
  'Search': Search,
  'MessageSquare': MessageSquare,
  'Pencil': Pencil,
  'Globe': Globe,
  'Link': Link,
  'Sparkles': Sparkles,
  'Dices': Dices,
  // Additional PascalCase icons used by the suggestion pill tree.
  'Plus': Plus,
  'PenTool': PenTool,
  'Presentation': Presentation,
  'FilePresentation': Presentation,
  'Table2': Table2,
  'Code2': Code2,
  'Wand2': Wand2,
  'ListChecks': ListChecks,
  'Megaphone': Megaphone,
  'MousePointerClick': MousePointerClick,
  'Compass': Compass,
  'Sun': Sun,
  'Moon': Moon,
  'FileSearch': FileSearch,
  'LineChart': LineChart,
  'Workflow': Workflow,
  'Notebook': Notebook,
  'AlertTriangle': AlertTriangle,
  'Folder': Folder,
  'Calendar': Calendar,
  'Edit3': Edit3,
  'Tag': Tag,
  'Mail': Mail,
  'MessageCircle': MessageCircle,
  'Share2': Share2,
  'ClipboardCheck': ClipboardCheck,
  'Send': Send,
  'FileDown': FileDown,
  'File': FileIcon,
  'MessageCircleQuestion': MessageCircleQuestion,
  'ShieldCheck': ShieldCheck,
  'ArrowDown': ArrowDown,
  'ArrowRight': ArrowRight,
  'Asterisk': Asterisk,
  // Brand icons
  'WordIcon': WordIcon,
};

function toPascalCase(value: string): string {
  return value
    .split(/[-_\s]+/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join('');
}

export function getIcon(name?: string): IconComponent | undefined {
  if (!name) return undefined;
  const trimmed = name.trim();
  if (!trimmed) return undefined;

  if (ICON_MAP[trimmed]) return ICON_MAP[trimmed];
  if (ICON_MAP[trimmed.toLowerCase()]) return ICON_MAP[trimmed.toLowerCase()];

  const normalizedPascal = toPascalCase(trimmed);
  if (ICON_MAP[normalizedPascal]) return ICON_MAP[normalizedPascal];

  const normalizedKebab = trimmed
    .replace(/[A-Z]/g, (match, offset) => (offset > 0 ? `-${match.toLowerCase()}` : match.toLowerCase()))
    .replace(/[_\s]+/g, '-');
  if (ICON_MAP[normalizedKebab]) return ICON_MAP[normalizedKebab];

  return undefined;
}

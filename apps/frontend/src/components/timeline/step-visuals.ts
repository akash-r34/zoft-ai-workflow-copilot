import {
  AlertTriangle,
  ArrowLeftRight,
  Brain,
  FileText,
  RotateCw,
  Search,
  ShieldCheck,
  Wand2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { TimelineRowKind } from "../../lib/step-map";

export const STEP_ICONS: Record<TimelineRowKind, LucideIcon> = {
  planning: Brain,
  searching_nodes: Search,
  reading_schema: FileText,
  validating: ShieldCheck,
  proposing: Wand2,
  repair: Wrench,
  validation_error: AlertTriangle,
  retry: RotateCw,
  provider_switch: ArrowLeftRight,
};

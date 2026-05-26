'use client';

/**
 * /copilot — full-screen Loom Copilot orchestrator.
 * Renders the shared CopilotConsoleView in non-embedded mode.
 */
import { CopilotConsoleView } from '@/lib/editors/cross-item-copilot-editor';

export default function CopilotPage() {
  return <CopilotConsoleView />;
}

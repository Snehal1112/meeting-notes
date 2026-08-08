import { AlertTriangle, Check } from "lucide-react";
import type { SummaryPass } from "@/lib/summary";

interface SummaryChecklistProps {
  /** The pass the latest summary-progress event named, "complete" once
   *  summarize_meeting has resolved successfully, or null before the first
   *  event has arrived. */
  currentStep: SummaryPass | "complete" | null;
  /** True when summarization failed while `currentStep` was active -- that
   *  step renders with an error marker instead of a spinner. */
  failed?: boolean;
  /** 0-based index of the transcript chunk currently being processed. */
  chunkIndex: number;
  /** Total transcript chunks for this run. */
  chunkTotal: number;
}

const PASS_ORDER: SummaryPass[] = ["NotesAndSummary", "ActionItems", "OpenQuestions"];

const PASS_LABELS: Record<SummaryPass, string> = {
  NotesAndSummary: "Extracting topics & summary",
  ActionItems: "Finding action items",
  OpenQuestions: "Checking for open questions",
};

export function SummaryChecklist({ currentStep, failed = false, chunkIndex, chunkTotal }: SummaryChecklistProps) {
  // -1 for null so no step is treated as "before" it (nothing is complete
  // yet); PASS_ORDER.length for "complete" so every step is treated as
  // before it (everything is complete).
  const currentIndex =
    currentStep === "complete" ? PASS_ORDER.length : currentStep === null ? -1 : PASS_ORDER.indexOf(currentStep);

  return (
    <div className="flex flex-col gap-2 w-full">
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground">Generating summary</span>
      {chunkTotal > 1 && (
        <span className="text-[9px] text-muted-foreground">
          Part {chunkIndex + 1} of {chunkTotal}
        </span>
      )}
      <div className="flex flex-col gap-2">
        {PASS_ORDER.map((pass, index) => {
          const isComplete = index < currentIndex;
          const isActive = index === currentIndex && currentStep !== "complete" && currentStep !== null;
          const isErrored = isActive && failed;

          return (
            <div key={pass} className="flex items-center gap-2">
              {isErrored ? (
                <AlertTriangle className="h-3.5 w-3.5 text-red-600 flex-shrink-0" aria-hidden="true" />
              ) : isComplete ? (
                <Check className="h-3.5 w-3.5 text-green-500 flex-shrink-0" aria-hidden="true" />
              ) : isActive ? (
                <span className="h-3.5 w-3.5 rounded-full border-2 border-primary/20 border-t-primary animate-spin flex-shrink-0" />
              ) : (
                <span className="h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/30 flex-shrink-0" />
              )}
              <span
                className={
                  isErrored
                    ? "text-xs text-red-600"
                    : isComplete
                      ? "text-xs text-muted-foreground line-through"
                      : isActive
                        ? "text-xs text-foreground"
                        : "text-xs text-muted-foreground"
                }
              >
                {PASS_LABELS[pass]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

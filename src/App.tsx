import { useEffect, useRef, useState } from "react";
import { TitleBar } from "@/components/TitleBar";
import { ConfigDialog } from "@/components/ConfigDialog";
import { RecorderWidget } from "@/components/RecorderWidget";
import { ResumePrompt } from "@/components/ResumePrompt";
import { configNeedsSetup, saveConfig, type AppConfig } from "@/lib/config";
import { getOrphanedMeetings, type MeetingMeta } from "@/lib/storage";
import { useAutoResizeWindow } from "@/hooks/useAutoResizeWindow";

function App() {
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const [orphaned, setOrphaned] = useState<MeetingMeta[]>([]);
  const [resumeMeeting, setResumeMeeting] = useState<MeetingMeta | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useAutoResizeWindow(rootRef, 400, 300);

  useEffect(() => {
    configNeedsSetup().then(setShowConfigDialog);
  }, []);

  // A recording left at "Recording" in the index means a previous session
  // was interrupted mid-capture. Its partial audio is still on disk and is
  // worth transcribing, so offer it on launch. A failure here must not stop
  // the user from recording, so it is logged rather than surfaced.
  useEffect(() => {
    getOrphanedMeetings()
      .then(setOrphaned)
      .catch((err) => console.error("Could not check for interrupted recordings:", err));
  }, []);

  const handleResume = (id: string) => {
    const meeting = orphaned.find((m) => m.id === id);
    if (!meeting) return;
    setResumeMeeting(meeting);
    setOrphaned((prev) => prev.filter((m) => m.id !== id));
  };

  const handleSave = async (config: AppConfig) => {
    await saveConfig(config);
    setShowConfigDialog(false);
  };

  const handleSkip = () => setShowConfigDialog(false);

  return (
    <div
      ref={rootRef}
      className="min-h-[300px] flex flex-col rounded-lg overflow-hidden border bg-background"
    >
      <TitleBar />
      {showConfigDialog ? (
        <ConfigDialog open={showConfigDialog} onSave={handleSave} onSkip={handleSkip} />
      ) : (
        <>
          <ResumePrompt
            meetings={orphaned}
            onResume={handleResume}
            onDismiss={() => setOrphaned([])}
          />
          <div className="flex-1 p-4">
            <RecorderWidget resumeMeeting={resumeMeeting} />
          </div>
        </>
      )}
    </div>
  );
}

export default App;

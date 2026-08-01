import { useEffect, useRef, useState } from "react";
import { TitleBar } from "@/components/TitleBar";
import { ConfigDialog } from "@/components/ConfigDialog";
import { configNeedsSetup, saveConfig, type AppConfig } from "@/lib/config";
import { useAutoResizeWindow } from "@/hooks/useAutoResizeWindow";

function App() {
  const [showConfigDialog, setShowConfigDialog] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useAutoResizeWindow(rootRef, 400, 300);

  useEffect(() => {
    configNeedsSetup().then(setShowConfigDialog);
  }, []);

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
        <div className="flex-1 p-4">{/* widget content goes here */}</div>
      )}
    </div>
  );
}

export default App;

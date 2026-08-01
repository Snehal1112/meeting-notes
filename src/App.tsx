import { TitleBar } from "@/components/TitleBar";

function App() {
  return (
    <div className="h-screen flex flex-col rounded-lg overflow-hidden border">
      <TitleBar />
      <div className="flex-1 p-4">{/* widget content goes here */}</div>
    </div>
  );
}

export default App;

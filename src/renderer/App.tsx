import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { ipc } from "@/gen/ipc"
import React from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

function App() {
  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  )
}

function AppContent() {
  const { theme, setTheme } = useTheme();

  function sayHello() {
    // Read the name from the input field.
    const name = (document.querySelector("#greet-input") as HTMLInputElement)?.value;
    // Make an IPC call to the main process and display the return value (greeting message).
    ipc.greet.SayHello({ name: name }).then((message) =>
      document.querySelector("#greet-msg")!.textContent = message.value
    );
  }

  function handleKeyPress(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      (document.querySelector("#greet-btn") as HTMLInputElement)?.click();
    }
  }

  function setAppTheme(newTheme: "light" | "dark" | "system") {
    ipc.app.SetTheme({ theme: newTheme }).then(() => setTheme(newTheme));
  }

  function animationStyle(delayMs: number) {
    return { animationDelay: `${delayMs}ms` };
  }

  return (
    <>
      {window.navigator.userAgent.indexOf("Mac") !== -1 && (<div className="draggable"></div>)}
      <div className="container flex flex-col mt-32 text-center relative">
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-secondary rounded-full p-1 border shadow-sm show-animation" style={animationStyle(400)}>
          <ToggleGroup
              type="single"
              value={theme}
              onValueChange={(val) => {
                if (val) setAppTheme(val as "light" | "dark" | "system");
              }}
              className="gap-0 relative flex"
            >
              <div
                className={`absolute left-0 top-0 bottom-0 w-9 h-6 rounded-full bg-background shadow-sm transition-transform duration-300 ease-in-out pointer-events-none ${
                  theme === "light" ? "translate-x-0" :
                  theme === "system" ? "translate-x-[36px]" :
                  "translate-x-[72px]"
                }`}
              />
              <ToggleGroupItem
                value="light"
                aria-label="Light theme"
                className="z-10 relative rounded-full min-w-0 w-9 h-6 p-0 bg-transparent data-[state=on]:bg-transparent data-[state=on]:text-foreground text-muted-foreground hover:text-foreground transition-colors duration-300 focus:bg-transparent hover:bg-transparent"
              >
                <Sun className="w-3 h-3" />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="system"
                aria-label="System theme"
                className="z-10 relative rounded-full min-w-0 w-9 h-6 p-0 bg-transparent data-[state=on]:bg-transparent data-[state=on]:text-foreground text-muted-foreground hover:text-foreground transition-colors duration-300 focus:bg-transparent hover:bg-transparent"
              >
                <Monitor className="w-3 h-3" />
              </ToggleGroupItem>
              <ToggleGroupItem
                value="dark"
                aria-label="Dark theme"
                className="z-10 relative rounded-full min-w-0 w-9 h-6 p-0 bg-transparent data-[state=on]:bg-transparent data-[state=on]:text-foreground text-muted-foreground hover:text-foreground transition-colors duration-300 focus:bg-transparent hover:bg-transparent"
              >
                <Moon className="w-3 h-3" />
              </ToggleGroupItem>
            </ToggleGroup>
        </div>
        <div className="flex justify-center show-animation" style={animationStyle(0)}>
          <img src="/logo.svg" style={{ height: "128px" }} alt="MōBrowser logo" />
        </div>
        <h1 className="text-4xl my-7 font-semibold show-animation" style={animationStyle(80)}>Welcome to MōBrowser!</h1>
        <p className="my-4 show-animation" style={animationStyle(160)}>Please enter your name and click the button.</p>
        <div className="flex justify-center items-center show-animation" style={animationStyle(240)}>
          <div className="flex">
            <Input id="greet-input"
              className="border border-gray-300 p-3 mr-2"
              placeholder="Your name"
              onKeyDown={handleKeyPress}
            />
            <Button id="greet-btn" type="button" onClick={sayHello}>
              Greet
            </Button>
          </div>
        </div>
        <p id="greet-msg" className="mt-4 show-animation" style={animationStyle(320)}></p>
      </div>
    </>
  );
}

export default App

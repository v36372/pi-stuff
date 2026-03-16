import * as fs from "fs";
import * as path from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ToolRegistry } from "./tool-registry";

/**
 * Watch the tools/ directory for file changes and hot-reload custom tools.
 */
export function watchTools(
  extensionRoot: string,
  pi: ExtensionAPI,
  toolRegistry: ToolRegistry,
  initialFileMap?: Map<string, string>
): { close(): void } {
  const toolsDir = path.join(extensionRoot, "tools");

  // Ensure tools/ exists so fs.watch doesn't fail
  if (!fs.existsSync(toolsDir)) {
    fs.mkdirSync(toolsDir, { recursive: true });
  }

  // filename → toolName mapping for tracking deletions/renames
  const fileToTool = new Map<string, string>(initialFileMap ?? []);

  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async function loadFile(filename: string): Promise<void> {
    const filePath = path.join(toolsDir, filename);

    if (!fs.existsSync(filePath)) {
      // File was deleted
      const toolName = fileToTool.get(filename);
      if (toolName) {
        toolRegistry.removeTool(toolName);
        fileToTool.delete(filename);
        // Deactivate the tool so the LLM no longer sees it
        const activeTools = pi.getActiveTools();
        pi.setActiveTools(activeTools.filter(name => name !== toolName));
        console.log(`[PTC] Watcher: removed tool: ${toolName} (${filename} deleted)`);
      }
      return;
    }

    try {
      // Clear require cache so Node picks up the updated file.
      // TypeScript compiles dynamic import() to require() under CommonJS,
      // so query-string cache-busting doesn't work — we must clear the cache entry.
      const resolved = require.resolve(filePath);
      delete require.cache[resolved];
      const mod = await import(filePath);
      const def = mod.default || mod;

      if (!def.name || !def.execute || !def.parameters) {
        console.warn(
          `[PTC] Watcher: skipping ${filename}: missing required fields (name, execute, parameters)`
        );
        return;
      }

      // If this file previously registered a different tool name, remove the old one
      const previousTool = fileToTool.get(filename);
      if (previousTool && previousTool !== def.name) {
        toolRegistry.removeTool(previousTool);
        const activeTools = pi.getActiveTools();
        pi.setActiveTools(activeTools.filter(name => name !== previousTool));
        console.log(`[PTC] Watcher: removed old tool: ${previousTool} (renamed to ${def.name})`);
      }

      // Register (or re-register) the tool via pi so the intercept picks it up
      pi.registerTool({
        name: def.name,
        label: def.label || def.name,
        description: def.description,
        parameters: def.parameters,
        execute: def.execute,
      });

      // Activate the new tool so the LLM can see it on the next turn
      const activeTools = pi.getActiveTools();
      if (!activeTools.includes(def.name)) {
        pi.setActiveTools([...activeTools, def.name]);
      }

      fileToTool.set(filename, def.name);
      console.log(`[PTC] Watcher: loaded/reloaded tool: ${def.name}`);
    } catch (err) {
      console.warn(`[PTC] Watcher: failed to load ${filename}:`, err);
    }
  }

  const watcher = fs.watch(toolsDir, (eventType, filename) => {
    if (!filename || !filename.endsWith(".js")) return;

    // Debounce: clear any pending timer for this file
    const existing = debounceTimers.get(filename);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      filename,
      setTimeout(() => {
        debounceTimers.delete(filename);
        loadFile(filename);
      }, 300)
    );
  });

  return {
    close() {
      watcher.close();
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
    },
  };
}

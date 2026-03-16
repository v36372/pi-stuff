import type { ToolDefinition, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  createReadTool,
  createBashTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import type { ToolInfo } from "./types";

/**
 * Registry for tracking registered tools and their execute functions
 */
export class ToolRegistry {
  private tools = new Map<string, ToolInfo>();
  private originalRegisterTool: ExtensionAPI["registerTool"];

  constructor(private pi: ExtensionAPI) {
    // Store the original registerTool method
    this.originalRegisterTool = pi.registerTool.bind(pi);

    // Intercept tool registrations to build our registry
    pi.registerTool = this.interceptRegisterTool.bind(this);
  }

  private interceptRegisterTool(tool: ToolDefinition<any, any>): void {
    // Store the tool with its execute function
    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
    });

    // Call the original registerTool
    this.originalRegisterTool(tool);
  }

  /**
   * Remove a tool from the registry by name
   */
  removeTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Create built-in tool instances using factory functions from pi-coding-agent.
   * pi.getAllTools() only returns metadata (no execute), so we need these
   * to get actual callable execute functions for built-in tools.
   */
  private createBuiltinTools(cwd: string): Map<string, ToolInfo> {
    const builtins = new Map<string, ToolInfo>();

    const factories: Array<{ name: string; create: (cwd: string) => any }> = [
      { name: "read", create: createReadTool },
      { name: "bash", create: createBashTool },
      { name: "edit", create: createEditTool },
      { name: "write", create: createWriteTool },
      { name: "grep", create: createGrepTool },
      { name: "find", create: createFindTool },
      { name: "ls", create: createLsTool },
    ];

    for (const { name, create } of factories) {
      try {
        const tool = create(cwd);
        builtins.set(name, {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          // AgentTool.execute has 4 args; ToolDefinition.execute has 5 (with ctx).
          // Wrap to match the ToolDefinition signature.
          execute: (toolCallId, params, signal, onUpdate, _ctx) =>
            tool.execute(toolCallId, params, signal, onUpdate),
        });
      } catch {
        // Skip tools that fail to create (e.g., missing dependencies)
      }
    }

    return builtins;
  }

  /**
   * Get all registered tools
   */
  getAllTools(cwd?: string): ToolInfo[] {
    const piTools = this.pi.getAllTools();
    const allTools = new Map<string, ToolInfo>();

    // Create built-in tool instances with execute functions
    const builtinTools = this.createBuiltinTools(cwd || process.cwd());

    // Add tools from pi.getAllTools() (metadata only)
    for (const piTool of piTools) {
      // Use factory-created builtin if available, otherwise mark as unavailable
      const builtin = builtinTools.get(piTool.name);
      const toolInfo: ToolInfo = {
        name: piTool.name,
        description: piTool.description,
        parameters: piTool.parameters,
        execute: builtin?.execute || (async () => {
          throw new Error(`Tool ${piTool.name} execute function not available`);
        }),
      };
      allTools.set(piTool.name, toolInfo);

      // Store in our registry if not already intercepted
      if (!this.tools.has(piTool.name) && builtin) {
        this.tools.set(piTool.name, toolInfo);
      }
    }

    // Override with intercepted tools (custom tools registered via pi.registerTool)
    for (const [name, tool] of this.tools.entries()) {
      allTools.set(name, tool);
    }

    return Array.from(allTools.values());
  }

  /**
   * Execute a tool by name
   */
  async executeTool(
    toolName: string,
    params: any,
    ctx: ExtensionContext,
    signal?: AbortSignal
  ): Promise<any> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}. Available: ${Array.from(this.tools.keys()).join(', ')}`);
    }

    // Generate a unique tool call ID
    const toolCallId = `ptc_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Execute the tool
    return await tool.execute(toolCallId, params, signal, undefined, ctx);
  }
}

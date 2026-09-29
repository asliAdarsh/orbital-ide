/**
 * The composer's slash commands.
 *
 * One catalogue serves both the palette and `/help`, so the two can never describe the command set
 * differently — the help dialog is literally the same rows, rendered somewhere the palette is not.
 *
 * A command is data; what it *does* needs the socket, the store and the draft, so the action lives
 * with the composer that owns those. `argument` marks the commands that read the rest of the line
 * instead of running the moment they are picked, which is the difference between `/help` and
 * `/rename Release 0.2`.
 */

export interface SlashCommand {
  /** As typed, without the slash. */
  id: string;
  /** One line saying what picking it does. */
  description: string;
  /** True when the command takes the rest of the line as its argument. */
  argument?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "model", description: "Choose the provider and model this chat runs on" },
  { id: "agents", description: "Pick the specialist this chat talks to" },
  { id: "skill", description: "Insert a skill's own prompt as the message" },
  { id: "explain", description: "Compose a prompt explaining what is attached" },
  { id: "new", description: "Start a new chat" },
  { id: "clear", description: "Empty this chat's transcript" },
  { id: "rename", description: "Rename this chat", argument: true },
  { id: "pause", description: "Pause the run at its next step" },
  { id: "resume", description: "Continue a paused run" },
  { id: "ask", description: "Ask a side question; the answer stays out of the transcript", argument: true },
  { id: "stop", description: "Stop the run and discard it" },
  { id: "help", description: "List every command" },
];

/** The command a `/word` names, or null when nothing matches exactly. */
export function commandById(id: string): SlashCommand | null {
  return SLASH_COMMANDS.find((command) => command.id === id) ?? null;
}

import { useClientSettings } from "../../hooks/useSettings";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";

/**
 * Fork-local: how this client starts a turn, so every path (send, steer, queue,
 * fan-out, plan follow-up, resume, compact, standalone and app messages) carries
 * the `autoClassifyThreads` setting the server reads on dispatch and launch.
 */
export function useStartThreadTurn() {
  const autoClassifyThreads = useClientSettings((settings) => settings.autoClassifyThreads);
  const dispatchThreadTurnStart = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  return (request: Parameters<typeof dispatchThreadTurnStart>[0]) =>
    dispatchThreadTurnStart({
      ...request,
      input: { ...request.input, autoClassifyThreads },
    });
}

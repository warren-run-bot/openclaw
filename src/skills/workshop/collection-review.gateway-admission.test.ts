import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayDrainingError,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  readConfigMachineState,
  writeConfigMachineState,
} from "../../state/config-machine-state.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { writeWorkspaceSkills } from "../test-support/e2e-test-helpers.js";
import { isSkillCollectionReviewDue } from "./collection-review-state.js";
import { runScheduledSkillCollectionReviews } from "./collection-review.js";

const runEmbeddedAgent = vi.hoisted(() => vi.fn());

vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
vi.mock("../../agents/auth-profiles/store.js", () => ({
  loadAuthProfileStoreForRuntime: () => ({ version: 1, profiles: {} }),
}));

let testState: OpenClawTestState;

beforeEach(async () => {
  resetGatewayWorkAdmission();
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-collection-review-admission-",
  });
});

afterEach(async () => {
  resetGatewayWorkAdmission();
  runEmbeddedAgent.mockReset();
  await testState.cleanup();
});

describe("skill collection review gateway admission", () => {
  it("keeps a due workspace and curator state unchanged when restart drain rejects admission", async () => {
    const workspaceDir = testState.workspaceDir;
    await writeWorkspaceSkills(workspaceDir, [
      { name: "useful", description: "Useful reusable procedure" },
    ]);
    const database = openOpenClawStateDatabase({ env: testState.env }).db;
    writeConfigMachineState(
      "skills.curatorState",
      {
        lastAttemptAtMs: 41,
        lastSuccessAtMs: 23,
        lastError: "previous unrelated failure",
        lastResult: {
          unrelated: { preserved: true },
          collectionReviewAttempts: { "other-workspace": 41 },
          collectionReviewSuccess: { "other-workspace": 23 },
        },
      },
      { env: testState.env },
    );
    const curatorStateBefore = readConfigMachineState("skills.curatorState", {
      env: testState.env,
    });
    const writesBefore = database.prepare("SELECT total_changes() AS count").get();
    expect(isSkillCollectionReviewDue(workspaceDir, Date.now(), { env: testState.env })).toBe(true);

    markGatewayRestartDraining();
    const onError = vi.fn();
    await runScheduledSkillCollectionReviews({
      config: {
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
        skills: { workshop: { autonomous: { mode: "auto" } } },
      },
      env: testState.env,
      onError,
    });

    expect(onError).toHaveBeenCalledWith(expect.any(GatewayDrainingError), workspaceDir);
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(readConfigMachineState("skills.curatorState", { env: testState.env })).toEqual(
      curatorStateBefore,
    );
    expect(database.prepare("SELECT total_changes() AS count").get()).toEqual(writesBefore);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM state_leases WHERE scope = ?")
        .get("skill-collection-review"),
    ).toEqual({ count: 0 });

    resetGatewayWorkAdmission();
    expect(isSkillCollectionReviewDue(workspaceDir, Date.now(), { env: testState.env })).toBe(true);
  });
});

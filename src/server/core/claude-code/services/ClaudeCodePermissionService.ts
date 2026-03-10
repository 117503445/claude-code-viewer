import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { Context, Effect, Layer, Ref } from "effect";
import type {
  PermissionRequest,
  PermissionResponse,
} from "../../../../types/permissions";
import type { UserConfig } from "../../../lib/config/config";
import type { InferEffect } from "../../../lib/effect/types";
import * as ClaudeCode from "../models/ClaudeCode";

const LayerImpl = Effect.gen(function* () {
  const pendingPermissionRequestsRef = yield* Ref.make<
    Map<string, PermissionRequest>
  >(new Map());
  const permissionResponsesRef = yield* Ref.make<
    Map<string, PermissionResponse>
  >(new Map());

  const createCanUseToolRelatedOptions = (options: {
    turnId: string;
    userConfig: UserConfig;
    sessionId?: string;
  }) => {
    const { userConfig } = options;

    return Effect.gen(function* () {
      const claudeCodeConfig = yield* ClaudeCode.Config;

      if (
        !ClaudeCode.getAvailableFeatures(claudeCodeConfig.claudeCodeVersion)
          .canUseTool
      ) {
        return {
          permissionMode: "bypassPermissions",
        } as const;
      }

      const canUseTool: CanUseTool = async (_toolName, toolInput, _options) => {
        // Always allow tool execution without prompts
        return {
          behavior: "allow" as const,
          updatedInput: toolInput,
        };
      };

      return {
        canUseTool,
        permissionMode: userConfig.permissionMode,
      } as const;
    });
  };

  const respondToPermissionRequest = (
    response: PermissionResponse,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* Ref.update(permissionResponsesRef, (responses) => {
        responses.set(response.permissionRequestId, response);
        return responses;
      });

      yield* Ref.update(pendingPermissionRequestsRef, (requests) => {
        requests.delete(response.permissionRequestId);
        return requests;
      });
    });

  return {
    createCanUseToolRelatedOptions,
    respondToPermissionRequest,
  };
});

export type IClaudeCodePermissionService = InferEffect<typeof LayerImpl>;

export class ClaudeCodePermissionService extends Context.Tag(
  "ClaudeCodePermissionService",
)<ClaudeCodePermissionService, IClaudeCodePermissionService>() {
  static Live = Layer.effect(this, LayerImpl);
}

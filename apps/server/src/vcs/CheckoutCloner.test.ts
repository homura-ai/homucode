// @effect-diagnostics nodeBuiltinImport:off - The fixture needs a folder on tmpfs, which has no reflinks.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as CheckoutCloner from "./CheckoutCloner.ts";

const tmpfs = "/dev/shm";

describe("CheckoutCloner", () => {
  // Without reflinks a "clone" would be a full copy, so the cache must not run at all.
  it.effect.runIf(NodeFS.existsSync(tmpfs))(
    "offers no cloner on Linux when the T3 home has no reflinks",
    () =>
      Effect.gen(function* () {
        const baseDir = NodeFS.mkdtempSync(NodePath.join(tmpfs, "t3-checkout-cloner-test-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true })),
        );
        const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provide(
              ServerConfig.layerTest(process.cwd(), baseDir).pipe(
                Layer.provideMerge(NodeServices.layer),
              ),
            ),
            Effect.provideService(HostProcess.Platform, "linux"),
          );
        assert.isFalse(yield* provide(CheckoutCloner.supported()));
        const cloner = yield* provide(
          CheckoutCloner.CheckoutCloner.pipe(Effect.provide(CheckoutCloner.layer)),
        );
        assert.isUndefined(cloner);
      }).pipe(Effect.scoped),
  );
});

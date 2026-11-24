// @effect-diagnostics nodeBuiltinImport:off - FileSystem has no reflink copy, and cp clones a folder in one call.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeUtil from "node:util";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

export class CheckoutCloneError extends Schema.TaggedError<CheckoutCloneError>()(
  "CheckoutCloneError",
  {
    source: Schema.String,
    destination: Schema.String,
    errno: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not clone ${this.source} to ${this.destination}${this.errno === undefined ? "" : ` (errno ${this.errno})`}.`;
  }
}

/**
 * Copies a file or a whole folder copy-on-write in one call, sharing data blocks until either
 * copy changes. The destination must not exist. Undefined where the platform has no such call.
 */
export const CheckoutCloner = Context.Reference<
  ((source: string, destination: string) => Effect.Effect<void, CheckoutCloneError>) | undefined
>("t3/vcs/CheckoutCloner", { defaultValue: () => undefined });

// A single-executable server resolves packages on disk only through `require`.
const requireForFfi = NodeModule.createRequire(import.meta.url);

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/**
 * Whether this server can clone checkouts: always on macOS, and on Linux when the T3 home's cache
 * folder takes reflinks (Btrfs, XFS, bcachefs). Linux probes once with a one-byte file.
 */
export const supported = Effect.fn("CheckoutCloner.supported")(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "darwin") return true;
  if (platform !== "linux") return false;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname((yield* ServerConfig.ServerConfig).worktreeCheckoutCacheDir);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const probe = yield* fileSystem.makeTempDirectoryScoped({
        directory,
        prefix: ".reflink-probe-",
      });
      const source = path.join(probe, "source");
      yield* fileSystem.writeFileString(source, "t");
      const clone = path.join(probe, "clone");
      yield* Effect.tryPromise({
        try: () => NodeFSP.copyFile(source, clone, NodeFSP.constants.COPYFILE_FICLONE_FORCE),
        catch: (cause) => new CheckoutCloneError({ source, destination: clone, cause }),
      });
      return true;
    }),
  ).pipe(Effect.orElseSucceed(() => false));
});

/** Linux `cp --reflink=always`, which fails rather than copy data when a clone is impossible. */
const reflinkCopy = Effect.fn("CheckoutCloner.reflink")(function* (
  source: string,
  destination: string,
) {
  yield* Effect.tryPromise({
    try: () =>
      execFile("cp", [
        "-a",
        "--reflink=always",
        "--no-target-directory",
        "--",
        source,
        destination,
      ]),
    catch: (cause) => new CheckoutCloneError({ source, destination, cause }),
  });
});

/** macOS `clonefile(2)` or Linux reflinks, which clone a folder hierarchy; elsewhere nothing. */
export const layer = Layer.effect(
  CheckoutCloner,
  Effect.gen(function* () {
    if (!(yield* supported())) return undefined;
    if ((yield* HostProcess.Platform) === "linux") return reflinkCopy;
    const loadClonefile = yield* Effect.cached(
      Effect.try({
        try: () => {
          const { DataType, load, open } = requireForFfi("ffi-rs") as typeof import("ffi-rs");
          open({ library: "t3-libsystem", path: "/usr/lib/libSystem.B.dylib" });
          return (source: string, destination: string) =>
            load({
              library: "t3-libsystem",
              funcName: "clonefile",
              retType: DataType.I32,
              paramsType: [DataType.String, DataType.String, DataType.I32],
              // CLONE_NOFOLLOW: clone a symlink itself rather than its target.
              paramsValue: [source, destination, 0x0001],
              errno: true,
              // A large folder takes hundreds of milliseconds; keep it off the event loop.
              runInNewThread: true,
            });
        },
        catch: (cause) =>
          new CheckoutCloneError({ source: "ffi-rs", destination: "clonefile", cause }),
      }),
    );
    return Effect.fn("CheckoutCloner.clonefile")(function* (source: string, destination: string) {
      const clonefile = yield* loadClonefile.pipe(
        Effect.mapError(
          (error) => new CheckoutCloneError({ source, destination, cause: error.cause }),
        ),
      );
      const result = yield* Effect.tryPromise({
        try: () => clonefile(source, destination),
        catch: (cause) => new CheckoutCloneError({ source, destination, cause }),
      });
      // ffi-rs types the errno form as a union with the plain return value.
      if (typeof result === "number" || result.value !== 0) {
        return yield* new CheckoutCloneError({
          source,
          destination,
          ...(typeof result === "number" ? {} : { errno: result.errnoCode }),
        });
      }
    });
  }),
);

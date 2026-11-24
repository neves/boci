import { printResult } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import {
  callCommand,
  outputOptions,
  sdkCommand,
} from "../../lib/custom-command.ts";
import {
  signatureError,
  signatureRegion,
  signatureRequest,
  vaultEndpoint,
} from "../../lib/container-image-signature.ts";

const algorithms = new Set(
  [224, 256, 384, 512].map((size) => `SHA_${size}_RSA_PKCS_PSS`),
);

type Signature = {
  kmsKeyId: string;
  kmsKeyVersionId: string;
  signingAlgorithm: string;
  message: string;
  signature: string;
};

export async function runArtifactsContainerImageSignatureGetVerify(
  ctx: CustomCommandContext,
): Promise<void> {
  const region = signatureRegion(ctx);
  const trusted = new Set(ctx.values.trusted_keys as string[]);
  const list = sdkCommand(
    ctx,
    "container image-signature get-verify",
    ctx.spec.commands["container image-signature list"]!.sdkOperations![0]!,
  );
  let page: string | null = null;
  do {
    ctx.io.out("Fetching signatures\n");
    const result = await callCommand(
      ctx,
      "artifacts",
      "container image-signature list",
      {
        compartment_id: ctx.values.compartment_id,
        compartment_id_in_subtree: ctx.values.compartment_id_in_subtree,
        repository_name: ctx.values.repo_name,
        image_digest: ctx.values.image_digest,
        page: page ?? undefined,
      },
      list,
    );
    if (!result.response.ok) printResult(ctx.io, result, outputOptions(ctx));
    if (result.response.status !== 200)
      signatureError(
        ctx,
        `Exception: ('Failed to list the signatures of repository_name %s, image_digest %s, status_code %d', '${ctx.values.repo_name}', '${ctx.values.image_digest}', ${result.response.status})`,
      );
    const items = (JSON.parse(result.raw) as { items: Signature[] | null })
      .items;
    if (!items)
      signatureError(ctx, "TypeError: 'NoneType' object is not iterable");
    const matches = items.filter(({ kmsKeyId }) => trusted.has(kmsKeyId));
    if (matches.length === 0)
      signatureError(
        ctx,
        "Exception: No signature in the image was signed by the supplied trusted keys",
      );
    ctx.io.out(
      `Filtered out ${items.length - matches.length} signatures by the trusted keys\nVerifying signature\n`,
    );
    page = result.response.headers.get("opc-next-page");
    for (const [index, item] of matches.entries()) {
      const endpoint = vaultEndpoint(ctx, item.kmsKeyId, region);
      if (!algorithms.has(item.signingAlgorithm))
        signatureError(
          ctx,
          "BadParameter: The signing algorithm is not valid. Please check.",
        );
      const verified = await signatureRequest(
        ctx,
        "kms",
        "crypto verified-data verify",
        {
          key_id: item.kmsKeyId,
          key_version_id: item.kmsKeyVersionId,
          message: item.message,
          signature: item.signature,
          signing_algorithm: item.signingAlgorithm,
        },
        endpoint,
      );
      const valid = JSON.parse(verified.raw).isSignatureValid;
      if (
        valid === true ||
        (index === matches.length - 1 && (valid !== false || page === null))
      ) {
        printResult(ctx.io, verified, outputOptions(ctx));
        return;
      }
    }
  } while (page !== null);
}

import { printResult } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import { outputOptions } from "../../lib/custom-command.ts";
import {
  registryEndpoint,
  signatureError,
  signatureRegion,
  signatureRequest,
  vaultEndpoint,
} from "../../lib/container-image-signature.ts";

export async function runArtifactsContainerImageSignatureSignUpload(
  ctx: CustomCommandContext,
): Promise<void> {
  const {
    compartment_id,
    image_id,
    kms_key_id,
    kms_key_version_id,
    signing_algorithm,
    description,
    metadata,
  } = ctx.values;
  if (metadata != null) {
    try {
      JSON.parse(String(metadata));
    } catch {
      signatureError(
        ctx,
        "Exception: Metadata should be in valid json format (alphanumeric characters only, with no whitespace or escape characters).",
      );
    }
  }

  const region = signatureRegion(ctx);
  const vault = vaultEndpoint(ctx, String(kms_key_id), region);
  ctx.io.out("Obtaining container image metadata by the image ID\n");
  const registry = registryEndpoint(ctx, region);
  const image = await signatureRequest(
    ctx,
    "artifacts",
    "container image get",
    { image_id },
    registry,
  );
  const { digest, repositoryName } = JSON.parse(image.raw);
  const json = JSON.stringify({
    description: description ?? "",
    imageDigest: digest ?? null,
    kmsKeyId: kms_key_id,
    kmsKeyVersionId: kms_key_version_id,
    metadata: metadata ?? "",
    region,
    repositoryName: repositoryName ?? null,
    signingAlgorithm: signing_algorithm,
  }).replace(
    /[\u007f-\uffff]/g,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const message = Buffer.from(json).toString("base64");

  ctx.io.out("Generating signature\n");
  const signed = await signatureRequest(
    ctx,
    "kms",
    "crypto signed-data sign",
    {
      message,
      key_id: kms_key_id,
      key_version_id: kms_key_version_id,
      signing_algorithm,
      message_type: "RAW",
    },
    vault,
  );
  const { signature } = JSON.parse(signed.raw);
  if (signature == null)
    signatureError(
      ctx,
      'TypeError: can only concatenate str (not "NoneType") to str',
    );
  ctx.io.out(`Signature: ${signature}\nUploading signature\n`);
  const uploaded = await signatureRequest(
    ctx,
    "artifacts",
    "container image-signature create",
    {
      compartment_id,
      image_id,
      kms_key_id,
      kms_key_version_id,
      signing_algorithm,
      message,
      signature,
    },
    registry,
  );
  if (uploaded.response.status !== 200)
    signatureError(
      ctx,
      'TypeError: can only concatenate str (not "int") to str',
    );
  const data = JSON.parse(uploaded.raw);
  if (data.signature == null || data.message == null || data.id == null)
    signatureError(
      ctx,
      'TypeError: can only concatenate str (not "NoneType") to str',
    );
  ctx.io.out(
    `Uploaded signature: ${data.signature}\nMessage: ${data.message}\nID: ${data.id}\n`,
  );
  printResult(ctx.io, uploaded, outputOptions(ctx));
}

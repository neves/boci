import { ConfigError, expandUser, fromFile } from "../../core/config.ts";
import { BadParameter } from "../../core/convert.ts";
import { wrapText } from "../../core/help/formatter.ts";
import {
  callOperation,
  createServiceClient,
  type GeneratedCommand,
} from "../../core/operation.ts";
import { printResult } from "../../core/output.ts";
import type { CustomCommandContext } from "../../core/registry.ts";
import { loadService } from "../../core/spec.ts";
import { readHiddenLine } from "../../core/stdin.ts";
import { waitForState } from "../../core/waiter.ts";
import { outputOptions } from "../../lib/custom-command.ts";
import { Exit } from "../../lib/io.ts";
import {
  confirmClick,
  createStdinReader,
  promptClick,
  runSetupConfig,
} from "../setup.ts";

const instructions = `
    This command provides a walkthrough of setting up instance principal authentication for an OCI compute instance.

    The following links provide information about topics and resources referenced by this script:

    Resource OCIDs:


    \b
    https://docs.oracle.com/en-us/iaas/Content/General/Concepts/identifiers.htm


    Compute Instances:


    \b
    https://docs.oracle.com/en-us/iaas/Content/Compute/Concepts/computeoverview.htm


    Dynamic Groups:


    \b
    https://docs.oracle.com/en-us/iaas/Content/Identity/Tasks/managingdynamicgroups.htm


    Policies:


    \b
    https://docs.oracle.com/en-us/iaas/Content/Identity/Concepts/policies.htm


    In order to successfully run this command, you must:


        - have an existing instance from which you want to run commands using instance principal authentication

        - be an administrator in your tenancy so that you can create/update the necessary dynamic group and policy used to enable instance principal authentication for your instance


    This script also requires an existing form of valid authentication to successfully run. If you do not have an existing config file and you ran this command using api_key or security_token auth, you will be prompted to create a new config file to use for authentication during this instance principal setup process.

${"    "}


`;

const endMessage = `
${"    "}

    If you haven't already, you can install the CLI on your instance by connecting to your instance using SSH and running the following command:


    \b
    bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"


    After you have installed the CLI on your instance, you can test out your instance principal authentication by connecting to your instance using SSH and running the following example command (Note: if you entered a custom policy that does not allow your dynamic group to view all compute instances in your instance's compartment, then the following example command will not work):


    \b
    oci compute instance list --compartment-id {compartment_id} --auth {auth}

${"    "}

`;

const ruleHelp =
  "For information about dynamic group matching rule syntax, please visit https://docs.oracle.com/en-us/iaas/Content/Identity/Tasks/managingdynamicgroups.htm#Writing";
const policyHelp =
  "For information about policy syntax, please visit https://docs.oracle.com/en-us/iaas/Content/Identity/Concepts/policysyntax.htm";
const policyPrompt =
  "Enter the statement(s) you would like to set for this policy (please enter your statements in JSON format, as a bracket-enclosed list of strings)";

function validateName(name: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(name))
    throw new BadParameter(
      "Invalid resource name. The name cannot contain spaces; only letters, numerals, hyphens, periods, or underscores are allowed.",
    );
  return name;
}

function validateOcid(ocid: string): string {
  if (
    !/^ocid1.[0-9a-zA-Z_-]+.oc[1-9][0-9]?.[0-9a-zA-Z_-]*.[0-9a-zA-Z_-]+$/.test(
      ocid,
    )
  )
    throw new BadParameter(
      "Invalid OCID format. OCID syntax can be found here: https://docs.oracle.com/en-us/iaas/Content/General/Concepts/identifiers.htm#Oracle",
    );
  return ocid;
}

function validateStatements(statements: string): string {
  try {
    JSON.parse(statements);
  } catch {
    throw new BadParameter(
      "Please enter your statements in JSON format, as a bracket-enclosed list of strings",
    );
  }
  return statements;
}

export async function runSetupInstancePrincipal(ctx: CustomCommandContext) {
  const { io, settings } = ctx;
  io.out(wrapText(instructions, 78, "", "", true) + "\n");
  const stdin = createStdinReader(io);
  const output = outputOptions(ctx);
  const confirm = (message: string, defaultValue = false) =>
    confirmClick(io, stdin, message, defaultValue, true);
  const prompt = (
    message: string,
    defaultValue?: string,
    valueProc?: (value: string) => string,
  ) =>
    promptClick(io, stdin, message, {
      default: defaultValue,
      valueProc,
      wrapExceptions: true,
    });

  const usePrincipal =
    settings.auth === "instance_principal" ||
    settings.auth === "resource_principal";
  let tenancy: string | boolean | null | undefined;
  if (!usePrincipal) {
    try {
      tenancy =
        io.env.OCI_CLI_TENANCY ??
        fromFile(settings.configFile, settings.profile, io.env, io.cwd).tenancy;
    } catch (error) {
      if (
        !(error instanceof ConfigError) ||
        error.type !== "ConfigFileNotFound"
      )
        throw error;
      const path = expandUser(settings.configFile, io.env);
      io.out(`ERROR: Could not find config file at ${path}\n`);
      if (settings.auth === "security_token") {
        if (
          !(await confirm(
            "Do you want to create a new config file with a CLI session profile that can be used with --auth security_token?",
            true,
          ))
        )
          throw new Exit(1);
        const { runSessionAuthenticate } = await import("../session.ts");
        await runSessionAuthenticate(io, {
          ...ctx,
          stdin,
          values: { profile_name: settings.profile, config_location: path },
        });
        io.out(
          `Successfully created config file ${path} with your new CLI session profile ${settings.profile}\nYou can now re-run your command to use your new session profile\n`,
        );
      } else {
        if (!(await confirm("Do you want to create a new config file?", true)))
          throw new Exit(1);
        await runSetupConfig(io, {
          stdin,
          regions: ctx.index.regions,
          usageError: ctx.usageError,
        });
        io.out(
          "Successfully created config file with your new CLI user profile\nOnce your public key is uploaded in the console, you can re-run your command to use your new config file and user profile\n",
        );
      }
      return;
    }
  }

  const [compute, iam] = await Promise.all([
    loadService("compute"),
    loadService("iam"),
  ]);
  let passphrase: string | undefined;
  const authIo = {
    ...io,
    async promptSecret(message: string) {
      passphrase ??= await readHiddenLine(io, stdin, message, true);
      return passphrase;
    },
  };
  const computeClient = await createServiceClient(authIo, {
    ...ctx,
    client: compute.clients["core.compute"]!,
  });
  const identityClient = await createServiceClient(authIo, {
    ...ctx,
    client: iam.clients["identity.identity"]!,
  });

  if (
    !(await confirm(
      "Do you have an existing compute instance for which you would like to set up instance principal authentication?",
      true,
    ))
  ) {
    io.out(
      "Please create a compute instance and then run this command again. For information regarding how to create a compute instance, please visit https://docs.oracle.com/en-us/iaas/Content/GSG/Reference/overviewworkflow.htm\n",
    );
    throw new Exit(1);
  }

  const resourceCall = async (resource: string, id: string) => {
    const instance = resource === "instance";
    const spec = instance ? compute : iam;
    const command = spec.commands[`${resource.replace(" ", "-")} get`]!;
    return callOperation(io, {
      ...ctx,
      spec,
      command,
      serviceClient: instance ? computeClient : identityClient,
      values: { [`${resource.replace(" ", "_")}_id`]: id },
    });
  };

  async function getResource(resource: string) {
    while (true) {
      const id = await prompt(
        `Enter the ${resource} OCID`,
        undefined,
        validateOcid,
      );
      const result = await resourceCall(resource, id);
      const data = JSON.parse(result.raw || "{}");
      if (result.response.ok) return { id, data };
      if (data.code !== "NotAuthorizedOrNotFound") {
        io.out(`Error: ${data.message}\n`);
        throw new Exit(1);
      }
      io.out(
        `Error: Could not find ${resource} with the given OCID; please ensure that you have entered the correct ${resource} OCID and that you are authorized to access the ${resource}\n`,
      );
    }
  }

  async function changeResource(
    command: GeneratedCommand,
    values: Record<string, unknown>,
  ) {
    const call = {
      ...ctx,
      spec: iam,
      command,
      stdin,
      serviceClient: identityClient,
      values: { ...values, wait_for_state: "ACTIVE" },
    };
    const initial = await callOperation(io, call);
    printResult(io, await waitForState(io, call, initial, output), output);
  }

  const instance = await getResource("instance");
  const compartmentId: string = instance.data.compartmentId;
  const compartment = await resourceCall("compartment", compartmentId);
  if (!compartment.response.ok) printResult(io, compartment, output);
  const compartmentName: string = JSON.parse(compartment.raw).name;

  let groupName: string;
  let newPolicy: boolean;
  const rulePrompt =
    "Enter the matching rule(s) you would like to set for this dynamic group";
  const instanceRule = `instance.id = '${instance.id}'`;
  if (
    await confirm(
      "Do you want to add this instance to an existing dynamic group?",
    )
  ) {
    const group = await getResource("dynamic group");
    groupName = group.data.name;
    io.out(ruleHelp + "\n");
    const currentRule: string = group.data.matchingRule;
    const normalized = currentRule.includes("{")
      ? currentRule.slice(
          currentRule.indexOf("{") + 1,
          currentRule.lastIndexOf("}"),
        )
      : currentRule;
    const matchingRule = await prompt(
      rulePrompt,
      currentRule.includes(instance.id)
        ? currentRule
        : `Any {${normalized}, ${instanceRule}}`,
    );
    await changeResource(iam.commands["dynamic-group update"]!, {
      dynamic_group_id: group.id,
      matching_rule: matchingRule,
    });

    newPolicy = await confirm(
      "Do you want to create a new policy for this group?",
    );
    if (
      !newPolicy &&
      (await confirm("Do you want to update a policy for this group?"))
    ) {
      const policy = await getResource("policy");
      io.out(policyHelp + "\n");
      const current = (policy.data.statements as string[] | null)
        ?.map((statement) => JSON.stringify(statement))
        .join(", ");
      const statements = await prompt(
        policyPrompt,
        current == null ? "null" : `[${current}]`,
        validateStatements,
      );
      if (
        !(await confirm(
          "WARNING: Updates to statements and freeform-tags and defined-tags will replace any existing values. Are you sure you want to continue?",
        ))
      ) {
        io.err("Abort: \n");
        throw new Exit(1);
      }
      const wrapper = iam.commands["policy update"]!;
      const update = wrapper.sdkOperations!.find(
        ({ method }) => method === "update_policy",
      )!;
      await changeResource(
        {
          operation: {
            ...update,
            lifecycleGetter: "get_policy",
            body: "details",
          },
        },
        {
          policy_id: policy.id,
          details: { statements: JSON.parse(statements) },
        },
      );
    }
  } else {
    if (usePrincipal) tenancy = (await getResource("tenancy")).id;
    groupName = await prompt(
      "Enter a name for your new dynamic group",
      undefined,
      validateName,
    );
    const description = await prompt(
      "Enter a description for your new dynamic group",
    );
    io.out(ruleHelp + "\n");
    const matchingRule = await prompt(rulePrompt, `Any {${instanceRule}}`);
    await changeResource(iam.commands["dynamic-group create"]!, {
      compartment_id: tenancy,
      name: groupName,
      description,
      matching_rule: matchingRule,
    });
    newPolicy = true;
  }

  if (newPolicy) {
    const name = await prompt(
      "Enter a name for the new policy to be used for your new dynamic group",
      undefined,
      validateName,
    );
    const description = await prompt(
      "Enter a description for the new policy to be used for your new dynamic group",
    );
    io.out(
      "WARNING: Using the default policy at the prompt below will grant all permissions for all your OCI resources to every instance in the dynamic group. Please ensure that this is the policy you want to use. If not, you can enter your custom policy statement(s) at the prompt.\n",
    );
    io.out(policyHelp + "\n");
    const statements = await prompt(
      policyPrompt,
      `["Allow dynamic-group ${groupName} to manage all-resources in compartment ${compartmentName}"]`,
      validateStatements,
    );
    const target = (await confirm(
      `This policy is currently set to be put in compartment ${compartmentName}, which is the compartment that your instance is in. Do you want to create this policy in a different compartment?`,
    ))
      ? (await getResource("compartment")).id
      : compartmentId;
    await changeResource(iam.commands["policy create"]!, {
      compartment_id: target,
      name,
      description,
      statements,
    });
  }
  io.out(
    "Successfully set up instance principal authentication for your instance!\n",
  );
  io.out(
    wrapText(
      endMessage
        .replace("{compartment_id}", compartmentId)
        .replace("{auth}", "instance_principal"),
      78,
      "",
      "",
      true,
    ) + "\n",
  );
}

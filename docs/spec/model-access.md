# Model access

Purpose: how a session decides which service provider and which model it talks to; what it does
with a model the packaged catalog does not describe; and where the choice is shown. Credentials are
read from the environment only; logging in, custom providers and switching models mid-session are
other units and are not covered here.

## Credentials

- **MODEL-001** Model credentials shall be read from environment variables, and an environment variable shall take precedence over a credential stored anywhere else.
- **MODEL-002** When no provider holds a credential, `pigeon run` shall fail with "no credentials: set an environment variable such as DEEPSEEK_API_KEY (routes: anthropic, openai, openai-compatible, google).".

## Choosing the provider

- **MODEL-003** When exactly one provider holds a credential, the runtime shall talk to that provider.
- **MODEL-004** When more than one provider holds a credential and neither a provider nor a model is given, `pigeon run` shall fail with "no model selected: more than one provider has credentials (<a>, <b>, <c>); pass --provider and --model, or run the terminal UI to choose one." and shall not choose one of them.
- **MODEL-005** When more than one provider holds a credential and nothing is given, the terminal UI shall present the same candidates and shall not pick one on its own.
- **MODEL-006** A provider given on the command line shall be used whatever the other providers hold.
- **MODEL-007** A provider whose route is not one the package ships shall be refused with "unknown provider \"<name>\"; packaged routes: anthropic, openai, openai-compatible, google.".
- **MODEL-008** A provider given on the command line that holds no credential shall be refused with "no credential for provider \"<name>\"; set <ENV>." naming that provider's environment variable.

## Choosing the model

- **MODEL-009** When only a model is given, the runtime shall infer the provider from it only if the catalog offers that model under exactly one provider and that provider holds a credential; otherwise it shall treat the provider as not given.
- **MODEL-010** A model the catalog offers under more than one provider shall be refused with "model \"<id>\" is offered by more than one provider (<a>, <b>); pass --provider.".
- **MODEL-011** The runtime shall not invent a default model for any provider.
- **MODEL-012** When a new session is started without a model, the runtime shall use the last used model recorded in the user settings.
- **MODEL-013** When a session is resumed, the runtime shall use the model recorded in that session, and the last used model shall not replace it.
- **MODEL-014** The provider and model a session runs with shall be written to the session record, so a later resume can pick them up without asking again.
- **MODEL-015** When exactly one provider holds a credential, no model is given and no last used model applies, `pigeon run` shall fail with "no model selected for provider \"<name>\"; pass --model.", and the terminal UI shall list that provider's catalog models as text.
- **MODEL-016** The last used model shall apply only while its provider holds a credential; otherwise it shall be ignored and the rest of these rules applied as if it were absent.
- **MODEL-017** A model given on the command line shall be sent as the model id of the request, not as a placeholder.
- **MODEL-018** A model given to a subagent shall apply to that subagent's requests only.

## Models the catalog does not know

- **MODEL-019** A model id the catalog does not describe shall be sent on the route of the chosen provider.
- **MODEL-020** When the context window of the model is unknown, the status bar shall leave out the context percentage (see VIEWS-012).
- **MODEL-021** The `modelInfo` setting shall be able to supply the facts of a model the catalog does not describe (its context window, output limit, prices and route), and a supplied fact shall be used in place of the unknown one.

## Showing the choice

- **MODEL-022** The status bar shall show the model the session is talking to, in dim text, after the mode segment and before the effort segment (see VIEWS-010).
- **MODEL-023** `/status` shall list the model the session is talking to.

## Routes

- **MODEL-026** The package shall ship the Anthropic, OpenAI, OpenAI-compatible and Google routes, and shall not offer Bedrock or subscription-account sign-in.

## Settings

- **MODEL-024** The last used model shall be kept in the user-level settings only, as the pair `{provider, model}` under the key `model.lastUsed`.
- **MODEL-025** Model facts given in the `modelInfo` section shall be taken from the settings layers the settings area already defines.

## Known limitations

- **MODEL-027** No default model is maintained for any provider, so a fresh install with one credentialed provider still asks for a model before it can send a request.
- **MODEL-028** A provider address (`baseUrl`) and a custom provider declared by the user are not part of this unit; the packaged providers are used with their catalogued routes.
- **MODEL-029** The full model picker, switching models mid-session and stored credentials are not part of this unit; until then the candidate list is text only.
- **MODEL-030** When `--stream-fn` (or `PIGEON_STREAM_FN`) names a module, that module shall supply the model, and the rules of this unit shall not choose one.
- **MODEL-031** In the subagent view the status bar shows its owning session's model until per-subagent display lands.

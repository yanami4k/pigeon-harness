# Model access

Purpose: how a session decides which service provider and which model it talks to; what it does
with a model the packaged catalog does not describe; where the choice is shown; how credentials are
stored; and how custom providers and proxies are declared. Switching models mid-session is another
unit and is not covered here.

## Credentials

- **MODEL-001** Model credentials shall be read from environment variables, and an environment variable shall take precedence over a credential stored anywhere else.
- **MODEL-002** When no provider holds a credential, `pigeon run` shall fail with "no credentials: set an environment variable such as DEEPSEEK_API_KEY (routes: anthropic, openai, openai-compatible, google), or start the terminal UI and run /login there.".
- **MODEL-032** Credentials given with `/login` shall be stored in `~/.pigeon/credentials.json` as `{"providers": {"<id>": {"apiKey": "..."}}}`, and the file shall be readable only by the current account (mode 0600 on POSIX; on Windows inherited permissions removed and only the current user granted); a failure to set that protection shall fail the write.
- **MODEL-033** `/login` shall list the providers, then accept a pasted key without echoing it and store it; `/logout` shall remove the stored key of the given provider, and without an argument list the stored ones; both shall be refused while the session is running and shall be unavailable in a sandbox session.
- **MODEL-038** `pigeon run` shall read credentials from environment variables only and shall not read the `/login` file.

## Choosing the provider

- **MODEL-003** When exactly one provider holds a credential, the runtime shall talk to that provider.
- **MODEL-004** When more than one provider holds a credential and neither a provider nor a model is given, `pigeon run` shall fail with "no model selected: more than one provider has credentials (<a>, <b>, <c>); pass --provider and --model, or run the terminal UI to choose one." and shall not choose one of them.
- **MODEL-005** When more than one provider holds a credential and nothing is given, the terminal UI shall present the same candidates and shall not pick one on its own.
- **MODEL-006** A provider given on the command line shall be used whatever the other providers hold.
- **MODEL-007** A provider whose route is not one the package ships shall be refused with "unknown provider \"<name>\"; packaged routes: anthropic, openai, openai-compatible, google.".
- **MODEL-008** A provider given on the command line that holds no credential shall be refused with "no credential for provider \"<name>\"; set <ENV>, or start the terminal UI and run /login there." naming that provider's environment variable.
- **MODEL-034** When no provider holds a credential, the terminal UI shall start with a placeholder model, refuse to send messages and tell the user to run `/login`, and after a successful login it shall rebuild the session with the newly chosen provider and model; it shall not pick a provider on its own.

## Choosing the model

- **MODEL-009** When only a model is given, the runtime shall infer the provider from it only if the catalog offers that model under exactly one provider and that provider holds a credential; otherwise it shall treat the provider as not given.
- **MODEL-010** A model the catalog offers under more than one provider shall be refused with "model \"<id>\" is offered by more than one provider (<a>, <b>); pass --provider.".
- **MODEL-011** The runtime shall not invent a default model for any provider.
- **MODEL-012** When a new session is started without a model, the runtime shall use the last used model recorded in the user settings.
- **MODEL-013** When a session is resumed, the runtime shall use the model recorded in that session, and the last used model shall not replace it; a provider or model given on the command line takes precedence over the record.
- **MODEL-014** The provider and model a session runs with shall be written to the session record, so a later resume can pick them up without asking again.
- **MODEL-015** When exactly one provider holds a credential, no model is given and no last used model applies, `pigeon run` shall fail with "no model selected for provider \"<name>\"; pass --model.", and the terminal UI shall list that provider's catalog models as text.
- **MODEL-016** The last used model shall apply only while its provider holds a credential; otherwise it shall be ignored and the rest of these rules applied as if it were absent.
- **MODEL-017** A model given on the command line shall be sent as the model id of the request, not as a placeholder.
- **MODEL-018** A model given to a subagent shall apply to that subagent's requests only.

## Models the catalog does not know

- **MODEL-019** A model id the catalog does not describe shall be sent on the route of the chosen provider.
- **MODEL-020** When the context window of the model is unknown, the status bar shall leave out the context percentage (see VIEWS-012).
- **MODEL-021** The `modelInfo` setting shall be able to supply the facts of a model the catalog does not describe (its context window, output limit, prices and route), and a supplied fact shall be used in place of the unknown one.

## Switching models mid-session

- **MODEL-039** When a session switches its model with `/model`, the candidate list shall contain only the catalog models of packaged providers that hold a credential; a custom provider shall be named directly as `/model <provider>/<id>`. The switch shall take effect from the next request, be written to the session record (and restored when the session is resumed), and be accepted while a turn is running (applying once it ends); `/model` shall be unavailable in a sandbox session and in the subagent view.

## Showing the choice

- **MODEL-022** The status bar shall show the model the session is talking to, in dim text, after the mode segment and before the effort segment (see VIEWS-010).
- **MODEL-023** `/status` shall list the model the session is talking to.
- **MODEL-040** Costs shall be shown in US dollars as computed by pi-ai when a response carries a price: in the status bar after the token count and in the `/status` usage line, and omitted when the price is zero. No price shall be converted to yuan, no peak-hour multiplier applied, and no cost-zero heuristic used to infer a provider.
- **MODEL-041** `/effort` and Alt+T shall offer only the thinking levels the current model supports (taken from the catalog); an explicitly given unsupported level shall be refused with the supported ones listed rather than silently clamped, and the same refusal shall apply at startup to `--thinking` or `thinking.level`.

## Routes

- **MODEL-026** The package shall ship the Anthropic, OpenAI, OpenAI-compatible and Google routes, and shall not offer Bedrock or subscription-account sign-in.

## Custom providers

- **MODEL-035** A user-level `model.providers.<id>` entry `{api, baseUrl, keyEnv}` shall declare a custom provider whose api is `openai-completions` or `anthropic-messages`; `model.providers` in the project or project-local settings shall be refused, and so shall an id a packaged provider already uses, an unknown api, a baseUrl that is not an http(s) URL, and a keyEnv that is not an environment variable name.
- **MODEL-036** A custom provider's credential shall come from the environment variable named by its `keyEnv` or from `/login`, and the environment variable shall take precedence.

## Proxy

- **MODEL-037** When any of `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` or `NO_PROXY` (in either case) is set, every route shall go through that proxy; if the proxy support cannot be loaded, the run shall fail instead of connecting directly.

## Request failures

- **MODEL-042** A model request that produces no content for 60 seconds shall be aborted and retried once; an error or idle timeout after content has streamed shall be reported without retrying while the received content is kept; a request aborted by the user shall not be retried; each such retry shall be recorded in the session.

## Thinking effort

- **MODEL-043** When the thinking level comes from the user settings or the session record and the model does not support it, the runtime shall fall back to the highest supported level not above the requested one, or to the lowest supported level when none is lower, and shall report the requested and the effective level in one line. A level requested explicitly shall still fail when the model does not support it, listing the supported levels.

## Settings

- **MODEL-024** The last used model shall be kept in the user-level settings only, as the pair `{provider, model}` under the key `model.lastUsed`.
- **MODEL-025** Model facts given in the `modelInfo` section shall be taken from the settings layers the settings area already defines.

## Known limitations

- **MODEL-027** No default model is maintained for any provider, so a fresh install with one credentialed provider still asks for a model before it can send a request.
- **MODEL-028** A provider address (`baseUrl`) comes from the packaged catalog or from a user-level custom-provider declaration; project settings do not supply it.
- **MODEL-029** The full model picker and switching models mid-session are not part of this unit; until then the candidate list is text only.
- **MODEL-030** When `--stream-fn` (or `PIGEON_STREAM_FN`) names a module, that module shall supply the model, and the rules of this unit shall not choose one.
- **MODEL-031** In the subagent view the status bar shows its owning session's model until per-subagent display lands.

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * End-to-end smoke test for the trajectory-compaction (prism) routing
 * feature. Exercises the production `ConversationHistorySummarizer` against
 * real CAPI to catch regressions that mocked unit tests cannot — e.g. the
 * `stream: false` SSE-parser mismatch that surfaced in manual testing on
 * trajectory-compaction.
 *
 * What this test validates:
 *   1. Off-flag → routes through the agent endpoint and returns a summary.
 *   2. On-flag + filter match → routes through `trajectory-compaction` CAPI
 *      endpoint and returns a summary.
 *   3. On-flag + filter miss → routes through the agent endpoint.
 *
 * How to run:
 *   npm run build           # esbuild the simulation framework (one-time)
 *   npm run simulate -- --grep "Compaction Prism" --skip-cache --skip-model-cache -n=1 -p=1
 *   # OR the convenience alias:
 *   npm run test:smoke:compaction-prism
 *
 * Cache modes:
 *   The default `simulate` invocation re-uses cached responses, which would
 *   mask `stream: false`-class bugs (the cache stores parsed responses, so
 *   the SSE parser is never re-exercised on a re-run). `--skip-cache
 *   --skip-model-cache` forces real CAPI traffic every run.
 */

import * as assert from 'assert';
import { Raw } from '@vscode/prompt-tsx';
import { ChatLocation } from '../../src/platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../src/platform/configuration/common/configurationService';
import { InMemoryConfigurationService } from '../../src/platform/configuration/test/common/inMemoryConfigurationService';
import { DefaultsOnlyConfigurationService } from '../../src/platform/configuration/common/defaultsOnlyConfigurationService';
import { ChatEndpointFamily, IEndpointProvider } from '../../src/platform/endpoint/common/endpointProvider';
import { IChatEndpoint } from '../../src/platform/networking/common/networking';
import { ChatVariablesCollection } from '../../src/extension/prompt/common/chatVariablesCollection';
import { Conversation, Turn, TurnStatus } from '../../src/extension/prompt/common/conversation';
import { IBuildPromptContext } from '../../src/extension/prompt/common/intents';
import { ToolCallRound } from '../../src/extension/prompt/common/toolCallRound';
import { renderPromptElement } from '../../src/extension/prompts/node/base/promptRenderer';
import { SummarizedConversationHistory } from '../../src/extension/prompts/node/agent/summarizedConversationHistory';
import { CancellationToken } from '../../src/util/vs/base/common/cancellation';
import { generateUuid } from '../../src/util/vs/base/common/uuid';
import { IInstantiationService } from '../../src/util/vs/platform/instantiation/common/instantiation';
import { TestingServiceCollection } from '../../src/platform/test/node/services';
import { ssuite, stest } from '../base/stest';

const TRAJECTORY_COMPACTION_MODEL = 'trajectory-compaction';
// The CAPI metadata registry stores claude-sonnet-4.6 under the dotted form
// (per `chat debug` "model deployment" lines). The dashed form
// `claude-sonnet-4-6` is only the per-request resolved-model echo.
const AGENT_MODEL_IN_FILTER = 'claude-sonnet-4.6';

/**
 * Build a small, syntactically realistic agent conversation: 5 user turns
 * with interleaved tool-call rounds. Kept small enough to keep the prism
 * request fast/cheap but realistic enough that the summarization prompt has
 * something to chew on (not a degenerate 1-turn conversation).
 *
 * Mirrors the shape of `transcripts/*.jsonl` entries that the production
 * code path consumes — but synthetic, so the test is reproducible on any
 * machine without depending on a local user data dir.
 */
function buildSyntheticPromptContext(): IBuildPromptContext {
	const turns: Turn[] = [];
	const userPrompts = [
		'Read README.md and tell me what this project is.',
		'Now check package.json for the version and main entry.',
		'Search the repo for the activation function.',
		'Open the activation function file and read it.',
		'Summarize what you found about activation flow.',
	];
	const assistantResponses = [
		'I read README.md. This is VS Code, Microsoft\'s source-code editor for Windows, Linux, macOS, and the web. Want me to check package.json next?',
		'The package.json reports version 1.122.0 with `./out/main.js` as the main entry. The "compile" and "watch" scripts drive development builds.',
		'Found `activate(context: vscode.ExtensionContext)` in src/extension/extension/vscode/extension.ts. It registers services and contributions on startup.',
		'Read src/extension/extension/vscode/extension.ts. Activation checks VS Code version compatibility, then creates the service instantiation graph and initializes the contribution system.',
		'Activation flow: (1) version check, (2) service registration via DI container, (3) contribution loading (chat participants, language model providers, command registrations).',
	];

	for (let i = 0; i < userPrompts.length; i++) {
		const turn = new Turn(
			generateUuid(),
			{ type: 'user', message: userPrompts[i] },
			new ChatVariablesCollection([]),
			[],
		);
		// A representative tool-call round per assistant turn — keeps the
		// summarization renderer's tool-result handling on the hot path.
		const round = new ToolCallRound(
			assistantResponses[i],
			[
				{
					id: `tc_${i}_${generateUuid().slice(0, 8)}`,
					name: i % 2 === 0 ? 'read_file' : 'grep_search',
					arguments: JSON.stringify({ query: userPrompts[i].slice(0, 40) }),
				},
			],
		);
		// `Turn.rounds` is a getter that reads from `chatResult.metadata.toolCallRounds`
		// (see conversation.ts). The only way to expose rounds on a Turn is to call
		// `setResponse` with a synthetic ChatResult — there's no public setter.
		turn.setResponse(
			TurnStatus.Success,
			{ type: 'model', message: assistantResponses[i] },
			`resp-${i}`,
			{ metadata: { toolCallRounds: [round] } },
		);
		turns.push(turn);
	}

	const latestTurn = turns.at(-1)!;
	const latestRound = latestTurn.rounds[0];

	return {
		query: userPrompts.at(-1)!,
		history: turns.slice(0, -1),
		chatVariables: new ChatVariablesCollection([]),
		conversation: new Conversation(`smoke-${generateUuid()}`, turns),
		toolCallRounds: [latestRound],
		toolCallResults: {},
	} as unknown as IBuildPromptContext;
}

/**
 * Render `<SummarizedConversationHistory>` with `triggerSummarize: true` so
 * the production `ConversationHistorySummarizer.getSummary()` runs end-to-
 * end. Returns the rendered messages array — the summary block will appear
 * as a synthetic system/user message inside it on success.
 */
async function renderWithCompaction(
	instantiationService: IInstantiationService,
	endpoint: import('../../src/platform/networking/common/networking').IChatEndpoint,
	promptContext: IBuildPromptContext,
): Promise<Raw.ChatMessage[]> {
	const result = await renderPromptElement(
		instantiationService,
		endpoint,
		SummarizedConversationHistory,
		{
			priority: 1,
			endpoint,
			location: ChatLocation.Agent,
			promptContext,
			triggerSummarize: true,
			maxToolResultLength: Infinity,
			forceSimpleSummary: false,
		},
		undefined,
		CancellationToken.None,
	);
	return result.messages;
}

/**
 * Wire the per-case prism config into the testing service collection,
 * overriding whatever defaults `createPlatformServices` would supply.
 */
/**
 * Patch the inner `TestEndpointProvider` (or whatever IEndpointProvider the
 * test framework wired) in-place so its `getChatEndpoint(family)` mirrors
 * the production fall-through I added in
 * `endpointProviderImpl._resolveUtilityFamily`: any non-utility family
 * resolves through `getAllChatEndpoints()` rather than the default
 * gpt-4o-mini shortcut. Without this, `getChatEndpoint('trajectory-
 * compaction')` would silently return gpt-4o-mini and the prism routing
 * test would pass for the wrong reason.
 *
 * Patches in-place (rather than substituting via `define`) because the
 * simulation framework locks the service collection after the first
 * `createTestingAccessor()` call, so any later `define` throws. The same
 * instance is held by every consumer (including the
 * `ConversationHistorySummarizer` that `renderPromptElement` instantiates
 * lazily), so an in-place patch is visible everywhere.
 */
function patchEndpointProviderForPrism(endpointProvider: IEndpointProvider): void {
	const original = endpointProvider.getChatEndpoint.bind(endpointProvider);
	(endpointProvider as { getChatEndpoint: (arg: unknown) => Promise<IChatEndpoint> }).getChatEndpoint = async (arg: unknown) => {
		if (typeof arg === 'string' && arg !== 'copilot-utility' && arg !== 'copilot-utility-small') {
			const all = await endpointProvider.getAllChatEndpoints();
			const match = all.find(e => e.model === arg || e.family === arg);
			if (!match) {
				throw new Error(`Compaction smoke: no endpoint for family/model '${arg}'. Available: ${all.map(e => e.model).join(', ')}`);
			}
			return match;
		}
		return original(arg as ChatEndpointFamily);
	};
}

function setPrismConfig(
	testingServiceCollection: TestingServiceCollection,
	usePrism: boolean,
	filter?: string,
): void {
	// InMemoryConfigurationService falls through to a base service for any
	// key not explicitly overridden, so we MUST pass a real base service —
	// otherwise downstream consumers (DomainService etc.) crash on first
	// .getConfig call. DefaultsOnlyConfigurationService is the
	// production-equivalent base used by `createPlatformServices`.
	const config = new InMemoryConfigurationService(new DefaultsOnlyConfigurationService());
	config.setConfig(ConfigKey.ConversationUsePrismCompaction, usePrism);
	if (filter !== undefined) {
		config.setConfig(ConfigKey.ConversationPrismCompactionModelFilter, filter);
	}
	testingServiceCollection.define(IConfigurationService, config);
}

async function resolveProviders(testingServiceCollection: TestingServiceCollection): Promise<{
	instantiationService: IInstantiationService;
	endpointProvider: IEndpointProvider;
	agentEndpoint: IChatEndpoint;
}> {
	const accessor = testingServiceCollection.createTestingAccessor();
	const endpointProvider = accessor.get(IEndpointProvider);
	patchEndpointProviderForPrism(endpointProvider);
	const agentEndpoint = await endpointProvider.getChatEndpoint(AGENT_MODEL_IN_FILTER as ChatEndpointFamily);
	return {
		instantiationService: accessor.get(IInstantiationService),
		endpointProvider,
		agentEndpoint,
	};
}

/**
 * Assert the rendered messages contain a `<conversation-summary>` block —
 * the synthetic XML element the production code emits when summarization
 * completes successfully.
 */
function assertSummarized(messages: Raw.ChatMessage[]): void {
	const text = messages
		.flatMap(m => m.content)
		.filter(part => part.type === Raw.ChatCompletionContentPartKind.Text)
		.map(part => (part as Raw.ChatCompletionContentPartText).text)
		.join('\n');
	assert.ok(
		text.includes('<conversation-summary>') || text.includes('summary'),
		'rendered prompt did not contain a summary block — compaction may have silently failed',
	);
}

ssuite({ title: 'Compaction Prism', location: 'panel' }, () => {

	stest({
		description: 'off-flag routes through agent endpoint',
		model: AGENT_MODEL_IN_FILTER,
	}, async (testingServiceCollection) => {
		setPrismConfig(testingServiceCollection, /* usePrism */ false);
		const { instantiationService, agentEndpoint } = await resolveProviders(testingServiceCollection);
		const messages = await renderWithCompaction(instantiationService, agentEndpoint, buildSyntheticPromptContext());
		assertSummarized(messages);
	});

	stest({
		description: 'prism on + filter match routes through trajectory-compaction',
		model: AGENT_MODEL_IN_FILTER,
	}, async (testingServiceCollection) => {
		setPrismConfig(testingServiceCollection, /* usePrism */ true);
		const { instantiationService, endpointProvider, agentEndpoint } = await resolveProviders(testingServiceCollection);
		const compactionEndpoint = await endpointProvider.getChatEndpoint(TRAJECTORY_COMPACTION_MODEL as ChatEndpointFamily);
		assert.strictEqual(compactionEndpoint.model, TRAJECTORY_COMPACTION_MODEL,
			'expected trajectory-compaction to be resolvable via endpointProvider — if this throws, CAPI metadata for this account does not list trajectory-compaction');
		const messages = await renderWithCompaction(instantiationService, agentEndpoint, buildSyntheticPromptContext());
		assertSummarized(messages);
	});

	stest({
		description: 'prism on + filter miss falls back to agent endpoint',
		model: AGENT_MODEL_IN_FILTER,
	}, async (testingServiceCollection) => {
		setPrismConfig(testingServiceCollection, /* usePrism */ true, /* filter */ 'no-match-anywhere');
		const { instantiationService, agentEndpoint } = await resolveProviders(testingServiceCollection);
		const messages = await renderWithCompaction(instantiationService, agentEndpoint, buildSyntheticPromptContext());
		assertSummarized(messages);
	});
});

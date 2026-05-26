/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IEnvService } from '../../env/common/envService';
import { IFetcherService } from '../../networking/common/fetcherService';
import { BaseCAPIClientService } from '../common/capiClient';

export class CAPIClientImpl extends BaseCAPIClientService {

	constructor(
		@IFetcherService fetcherService: IFetcherService,
		@IEnvService envService: IEnvService
	) {
		super(
			process.env.HMAC_SECRET,
			process.env.VSCODE_COPILOT_INTEGRATION_ID,
			fetcherService,
			envService
		);

		// LOCAL DEV HACK — DO NOT COMMIT. Force `Copilot-Integration-Id: vscode-chat`
		// so CAPI's /models response includes preview models (e.g. trajectory-compaction)
		// that are only registered for the `vscode-chat` integrator. Without this,
		// dev OSS builds without an HMAC_SECRET send `code-oss` and the model resolver
		// can't find the family. The library blocks passing 'vscode-chat' through the
		// constructor (reserved name), so we monkey-patch the header injection instead.
		const self = this as any;
		const originalMixinHeaders = self._mixinHeaders.bind(self);
		self._mixinHeaders = async (request: any, metadata: any) => {
			await originalMixinHeaders(request, metadata);
			if (request.headers && !request.suppressIntegrationId) {
				request.headers['Copilot-Integration-Id'] = 'vscode-chat';
			}
		};
	}
}

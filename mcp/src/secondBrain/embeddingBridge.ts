import type { EmbeddingProvider } from '../compiler/offlineKnowledgeCompiler.js';
import type { EmbeddingAdapter } from '../hybrid/embedding.js';

/** Uses one adapter identity for offline compilation and online query vectors. */
export function createOfflineEmbeddingProvider(adapter: EmbeddingAdapter): EmbeddingProvider {
	return {
		adapterId: adapter.id,
		modelId: adapter.modelId,
		kind: adapter.kind,
		dimensions: adapter.dimension,
		async embed(records) {
			const controller = new AbortController();
			return adapter.embed(
				records.map((record) => record.text),
				{ signal: controller.signal, deadlineAt: Number.MAX_SAFE_INTEGER },
			);
		},
	};
}

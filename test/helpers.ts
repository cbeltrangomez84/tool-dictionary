import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Dictionary } from '../src/types';

export const EXAMPLE_PATH = path.resolve(__dirname, '..', 'spec', 'examples', 'crypto-data.dictionary.json');

export function example(): Dictionary {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')) as Dictionary;
}

/** A small second dictionary, for branches and multi-tenancy. */
export function nftDictionary(overrides: Partial<Dictionary> = {}): Dictionary {
  return {
    toolDictionary: '0.1',
    id: 'nft-data',
    title: 'NFT data',
    summary: 'Collections, floors and owners.',
    version: 3,
    generatedAt: '2026-09-01T00:00:00Z',
    defaults: { baseUrl: 'https://nft.example.com', auth: { kind: 'caller', hint: 'x-api-key' } },
    index: {
      nodes: [
        {
          path: 'collections',
          title: 'Collections',
          summary: 'Floor price and owner stats per collection.',
          sampleQueries: ['floor price', 'how many owners'],
        },
      ],
    },
    entries: [
      {
        name: 'collection_floor',
        title: 'Collection floor price',
        summary: 'Lowest listed price for a collection right now.',
        path: 'collections',
        keywords: ['floor', 'floor price', 'cheapest listing'],
        input: { type: 'object', properties: { collection: { type: 'string', description: 'Collection slug or contract.' } }, required: ['collection'] },
        call: { type: 'http', method: 'GET', urlTemplate: '/v1/collections/{collection}/floor' },
      },
      {
        name: 'holders_count',
        title: 'Collection owner count',
        summary: 'Number of distinct wallets owning at least one item of a collection.',
        path: 'collections',
        keywords: ['owners', 'holders', 'unique owners'],
        input: { type: 'object', properties: { collection: { type: 'string' } }, required: ['collection'] },
        call: { type: 'http', method: 'GET', urlTemplate: '/v1/collections/{collection}/owners/count' },
        relations: [{ type: 'pairs_with', target: 'collection_floor', reason: 'owners and floor together describe demand' }],
      },
    ],
    ...overrides,
  } as Dictionary;
}

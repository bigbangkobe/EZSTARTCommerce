import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

export class ContractValidationError extends Error {}

export class IdentityContracts {
  private readonly ajv = new Ajv2020({ strict: false, allErrors: false, allowUnionTypes: true });
  private readonly schemas: Record<string, unknown>;
  readonly ownerPermissions: string[];
  constructor() {
    const spec = parse(readFileSync(resolve('packages/contracts/openapi.yaml'), 'utf8'));
    this.schemas = spec.components.schemas;
    addFormats.default(this.ajv); // CJS plugin exposes the same function through .default.
    this.ownerPermissions = [...new Set<string>(Object.values(spec.paths as Record<string, Record<string, unknown>>).flatMap(path =>
      Object.values(path).flatMap(operation => {
        if (typeof operation !== 'object' || operation === null || !('x-permission' in operation)) return [];
        return typeof operation['x-permission'] === 'string' ? [operation['x-permission']] : [];
      })))].sort();
  }
  assert(name: string, body: unknown): void {
    const key = `identity:${name}`;
    let validate = this.ajv.getSchema(key);
    if (!validate) {
      validate = this.ajv.compile({ $id: key, $ref: `#/components/schemas/${name}`, components: { schemas: this.schemas } });
    }
    if (!validate(body)) throw new ContractValidationError('Request does not match contract');
  }
}

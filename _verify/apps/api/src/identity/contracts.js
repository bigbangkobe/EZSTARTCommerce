import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';
export class ContractValidationError extends Error {
}
export class IdentityContracts {
    ajv = new Ajv2020({ strict: false, allErrors: false, allowUnionTypes: true });
    schemas;
    ownerPermissions;
    constructor() {
        const spec = parse(readFileSync(resolve('packages/contracts/openapi.yaml'), 'utf8'));
        this.schemas = spec.components.schemas;
        addFormats.default(this.ajv); // CJS plugin exposes the same function through .default.
        this.ownerPermissions = [...new Set(Object.values(spec.paths).flatMap(path => Object.values(path).flatMap(value => {
                if (typeof value !== 'object' || value === null || Array.isArray(value))
                    return [];
                const operation = value;
                const codes = [];
                // 端点级与字段级权限同属一个闭集：owner 必须两者都持有，否则字段级脱敏对店主也生效。
                if (typeof operation['x-permission'] === 'string')
                    codes.push(operation['x-permission']);
                const fieldPermissions = operation['x-field-permissions'];
                if (Array.isArray(fieldPermissions)) {
                    for (const code of fieldPermissions)
                        if (typeof code === 'string')
                            codes.push(code);
                }
                return codes;
            })))].sort();
    }
    assert(name, body) {
        const key = `identity:${name}`;
        let validate = this.ajv.getSchema(key);
        if (!validate) {
            validate = this.ajv.compile({ $id: key, $ref: `#/components/schemas/${name}`, components: { schemas: this.schemas } });
        }
        if (!validate(body)) {
            // 只保留字段路径与规则名：定位契约缺口时必须知道是哪个字段，而不是只知道“不匹配”。
            const detail = (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? ''}`.trim()
                + (error.params && 'additionalProperty' in error.params ? ` (${String(error.params.additionalProperty)})` : ''))
                .slice(0, 5).join('; ');
            throw new ContractValidationError(`Request does not match contract: ${detail}`);
        }
    }
}

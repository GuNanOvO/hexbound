import test from 'node:test';
import assert from 'node:assert/strict';
import { makeContext } from './helpers.js';
import { analyzeReact } from '../src/rules/react.js';
import type { Finding, Policy, RuleId } from '../src/types.js';

function analyze(files: Readonly<Record<string, string>>, overrides: Partial<Policy> = {}): Finding[] {
  const context = makeContext(files, overrides);
  try {
    return analyzeReact(context);
  } finally {
    context.cleanup();
  }
}

function ofRule(findings: readonly Finding[], ruleId: RuleId): Finding[] {
  return findings.filter(item => item.ruleId === ruleId);
}

function messageDetail(findings: readonly Finding[]): string {
  return findings.map(item => `${item.ruleId} ${item.file}:${item.line}:${item.column}`).join('\n');
}

function findingLines(findings: readonly Finding[]): number[] {
  return findings.map(item => item.line).sort((left, right) => left - right);
}

function fixtureLines(source: string, markers: readonly string[]): number[] {
  return markers.map(marker => {
    const index = source.indexOf(marker);
    assert.ok(index >= 0, `fixture is missing marker: ${marker}`);
    return source.slice(0, index).split('\n').length;
  }).sort((left, right) => left - right);
}

test('HB001 accepts named React imports, a pure reducer, and a readonly number counter event', () => {
  const findings = analyze({
    'src/Counter.tsx': `
      import { useReducer, type ReactNode } from 'react';

      type CounterEvent = { type: 'increment' } | { type: 'decrement' };

      function counterReducer(state: number, event: CounterEvent): number {
        switch (event.type) {
          case 'increment': return state + 1;
          case 'decrement': return state - 1;
        }
      }

      export function Counter({ label }: Readonly<{ label: ReactNode }>): ReactNode {
        const [count, dispatch] = useReducer(counterReducer, 0);
        return <button type="button" onClick={() => dispatch({ type: 'increment' })}>{label}{count}</button>;
      }
    `,
  });
  assert.deepEqual(findings, []);
});

test('HB001 rejects default, namespace, CommonJS, and dynamic React access routes', () => {
  const source = `
      import React from 'react';
      import * as ReactNS from 'react';
      const required = require('react');
      const lazy = import('react');

      export const a = React.useState;
      export const b = ReactNS.useState;
      export const c = required.useState;
      export const d = lazy;
    `;
  const findings = analyze({ 'src/routes.ts': source });
  const violations = ofRule(findings, 'HB001');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, [
      'import React from',
      'import * as ReactNS',
      "require('react')",
      "import('react')",
      'React.useState',
      'ReactNS.useState',
      'required.useState',
    ]),
    messageDetail(violations),
  );
  assert.deepEqual([...new Set(violations.map(item => item.file))], ['src/routes.ts']);
});

test('HB001 permits type-only React namespaces', () => {
  const findings = analyze({
    'src/types.ts': `
      import type * as React from 'react';
      export type Node = React.ReactNode;
    `,
  });
  assert.deepEqual(findings, []);
});

test('HB001 rejects aliased useState imports and calls', () => {
  const source = `
      import { useState as useLocalState } from 'react';

      export function Counter(): number {
        const [value, setValue] = useLocalState(0);
        setValue(1);
        return value;
      }
    `;
  const findings = analyze({ 'src/state.tsx': source });
  const violations = ofRule(findings, 'HB001');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['useState as useLocalState', 'useLocalState(0)']),
    messageDetail(violations),
  );
});

test('HB001 does not flag same-spelling local hooks as React hooks', () => {
  const findings = analyze({
    'src/local-hook.ts': `
      export function useState(initial: number): [number, (next: number) => void] {
        return [initial, () => undefined];
      }
    `,
    'src/local-effect.ts': `
      export function useEffect(run: () => void): void {
        run();
      }
    `,
    'src/uses-local.ts': `
      import { useState } from './local-hook';
      import { useEffect } from './local-effect';

      export function Counter(): number {
        const [value, setValue] = useState(0);
        useEffect(() => undefined);
        setValue(1);
        return value;
      }
    `,
  });
  assert.deepEqual(ofRule(findings, 'HB001'), []);
  assert.deepEqual(ofRule(findings, 'HB002'), []);
});

test('HB001 and HB002 reject re-exported raw hooks but not unrelated local re-exports', () => {
  const stateReexport = `
      export { useState as useLocalState } from 'react';
    `;
  const effectReexport = `
      export { useEffect } from 'react';
    `;
  const findings = analyze({
    'src/local-hook.ts': `
      export function useState(initial: number): [number, (next: number) => void] {
        return [initial, () => undefined];
      }
    `,
    'src/state-reexport.ts': stateReexport,
    'src/effect-reexport.ts': effectReexport,
    'src/local-reexport.ts': `
      export { useState as useLocal } from './local-hook';
    `,
  });
  const stateViolations = ofRule(findings, 'HB001');
  assert.equal(stateViolations.length, 1, messageDetail(stateViolations));
  assert.deepEqual(
    [stateViolations[0]?.file, stateViolations[0]?.line],
    ['src/state-reexport.ts', fixtureLines(stateReexport, ['export {'])[0]],
  );
  const effectViolations = ofRule(findings, 'HB002');
  assert.equal(effectViolations.length, 1, messageDetail(effectViolations));
  assert.deepEqual(
    [effectViolations[0]?.file, effectViolations[0]?.line],
    ['src/effect-reexport.ts', fixtureLines(effectReexport, ['export {'])[0]],
  );
});

test('HB002 allows annotated effects and effect events inside the effect adapter root', () => {
  const findings = analyze({
    'hooks/effects/use-title.ts': `
      import { useEffect, useEffectEvent } from 'react';

      export function useTitle(title: string): void {
        /**
         * @effect-external Browser document title
         * @effect-setup Mirror the supplied title into document.title
         * @effect-cleanup none: The title is a last-writer-wins mirror with no restore contract
         */
        useEffect(() => {
          document.title = title;
        }, [title]);
      }

      export function useSocketEvent(): void {
        /**
         * @effect-external Websocket subscription owned by the parent effect
         * @effect-lifecycle Owned by the parent effect that registers the websocket listener
         */
        useEffectEvent(() => undefined);
      }
    `,
  });
  assert.deepEqual(findings, []);
});

test('HB002 rejects effect imports and calls outside the effect adapter root', () => {
  const source = `
      import { useEffect } from 'react';

      export function Widget(): null {
        useEffect(() => undefined, []);
        return null;
      }
    `;
  const findings = analyze({ 'src/ui/Widget.tsx': source });
  const violations = ofRule(findings, 'HB002');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['import { useEffect }', 'useEffect(() => undefined, [])']),
    messageDetail(violations),
  );
  assert.ok(violations.every(item => item.file === 'src/ui/Widget.tsx'));
});

test('HB002 rejects effect hook aliases and wrapper calls outside the adapter root', () => {
  const source = `
      import { useEffect } from 'react';

      const runEffect = useEffect;

      export function useWidget(): void {
        runEffect(() => undefined, []);
      }
    `;
  const findings = analyze({ 'src/ui/effect-alias.ts': source });
  const violations = ofRule(findings, 'HB002');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['import { useEffect }', 'const runEffect = useEffect', 'runEffect(() => undefined, [])']),
    messageDetail(violations),
  );
});

test('HB002 requires every nonempty effect annotation slot', () => {
  const source = `
      import { useEffect } from 'react';

      export function useMissing(): void {
        /** @effect-external Network sync */
        useEffect(() => undefined, []);
      }
    `;
  const findings = analyze({ 'hooks/effects/use-missing.ts': source });
  const violations = ofRule(findings, 'HB002');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['useEffect(() => undefined, [])']),
    messageDetail(violations),
  );
});

test('HB002 requires a reason after none in the cleanup slot', () => {
  const source = `
      import { useEffect } from 'react';

      export function useBad(): void {
        /**
         * @effect-external Network sync
         * @effect-setup Subscribe to the feed
         * @effect-cleanup none
         */
        useEffect(() => undefined, []);
      }
    `;
  const findings = analyze({ 'hooks/effects/use-bad-cleanup.ts': source });
  const violations = ofRule(findings, 'HB002');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['useEffect(() => undefined, [])']),
    messageDetail(violations),
  );
});

test('HB003 allows an exhaustiveness assertion in the default clause', () => {
  const findings = analyze({
    'src/store.ts': `
      import { useReducer } from 'react';

      type State = { readonly count: number };
      type Event = { type: 'increment'; by: number } | { type: 'reset' };

      function assertNever(value: never): never {
        throw new Error('unexpected event');
      }

      function reducer(state: State, event: Event): State {
        switch (event.type) {
          case 'increment': return { count: state.count + event.by };
          case 'reset': return { count: 0 };
          default: return assertNever(event);
        }
      }

      export const useCounter = () => useReducer(reducer, { count: 0 });
    `,
  });
  assert.deepEqual(findings, []);
});

test('HB003 accepts a single-event reducer discriminated by kind', () => {
  const findings = analyze({
    'src/increment.ts': `
      import { useReducer } from 'react';

      type Event = { kind: 'increment'; by: number };

      function reducer(state: number, event: Event): number {
        switch (event.kind) {
          case 'increment': return state + event.by;
        }
      }

      export const useCounter = () => useReducer(reducer, 0);
    `,
  });
  assert.deepEqual(findings, []);
});

test('HB003 rejects a non-exhaustive reducer switch', () => {
  const source = `
      import { useReducer } from 'react';

      type Event = { type: 'increment' } | { type: 'decrement' };

      function reducer(state: number, event: Event): number {
        switch (event.type) {
          case 'increment': return state + 1;
        }
        return state;
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const findings = analyze({ 'src/counter.ts': source });
  const violations = ofRule(findings, 'HB003');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['switch (event.type)']),
    messageDetail(violations),
  );
});

test('HB003 rejects a default clause that is not a never proof', () => {
  const source = `
      import { useReducer } from 'react';

      type Event = { type: 'increment' } | { type: 'decrement' };

      function reducer(state: number, event: Event): number {
        switch (event.type) {
          case 'increment': return state + 1;
          case 'decrement': return state - 1;
          default: return state;
        }
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const findings = analyze({ 'src/counter.ts': source });
  const violations = ofRule(findings, 'HB003');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['switch (event.type)']),
    messageDetail(violations),
  );
});

test('HB003 rejects generic state updates, Partial state, updater callbacks, and record payloads', () => {
  const source = `
      import { useReducer } from 'react';

      type State = { count: number };

      type Event =
        | { type: 'SET'; value: State }
        | { type: 'PATCH'; value: Partial<State> }
        | { type: 'UPDATE'; update: (state: State) => State }
        | { type: 'TALLY'; rows: Record<string, number> };

      function reducer(state: State, event: Event): State {
        switch (event.type) {
          case 'SET': return event.value;
          case 'PATCH': return { ...state, ...event.value };
          case 'UPDATE': return event.update(state);
          case 'TALLY': return { count: state.count + Object.keys(event.rows).length };
        }
      }

      export const useStore = () => useReducer(reducer, { count: 0 });
    `;
  const findings = analyze({ 'src/store.ts': source });
  const violations = ofRule(findings, 'HB003');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, [
      "type: 'SET'",
      'value: State',
      "type: 'PATCH'",
      'value: Partial<State>',
      "type: 'UPDATE'",
      'update: (state: State) => State',
      'rows: Record<string, number>',
    ]),
    messageDetail(violations),
  );
});

test('HB003 rejects actions without finite literal discriminants', () => {
  const source = `
      import { useReducer } from 'react';

      type Event = { type: string; value: number };

      function reducer(state: { readonly value: number }, event: Event): { readonly value: number } {
        switch (event.type) {
          default: return state;
        }
      }

      export const useStore = () => useReducer(reducer, { value: 0 });
    `;
  const findings = analyze({ 'src/store.ts': source });
  const violations = ofRule(findings, 'HB003');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['type: string;']),
    messageDetail(violations),
  );
});

test('HB003 rejects direct side effects inside a reducer', () => {
  const source = `
      import { useReducer } from 'react';

      type Event = { type: 'load' } | { type: 'store' };

      function reducer(state: number, event: Event): number {
        switch (event.type) {
          case 'load':
            void fetch('/api/items');
            console.log('loading');
            localStorage.setItem('last', String(Date.now()));
            return state;
          case 'store':
            return Math.floor(Math.random() * 10);
        }
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const findings = analyze({ 'src/effects.ts': source });
  const violations = ofRule(findings, 'HB003');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, [
      "void fetch('/api/items')",
      "console.log('loading')",
      "localStorage.setItem('last', String(Date.now()))",
      'Date.now()',
      'Math.random()',
    ]),
    messageDetail(violations),
  );
});

test('HB003 rejects async reducers and await', () => {
  const source = `
      import { useReducer } from 'react';

      type Event = { type: 'load' };

      async function reducer(state: number, event: Event): Promise<number> {
        switch (event.type) {
          case 'load': {
            await Promise.resolve();
            return state;
          }
        }
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const findings = analyze({ 'src/async-store.ts': source });
  const violations = ofRule(findings, 'HB003');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['async function reducer', 'await Promise.resolve()']),
    messageDetail(violations),
  );
});

test('HB003 anchors analysis at an imported reducer definition', () => {
  const definition = `
      export type Event = { type: 'open' } | { type: 'close' };

      export function reducer(state: number, event: Event): number {
        switch (event.type) {
          case 'open': return state + 1;
        }
        return state;
      }
    `;
  const findings = analyze({
    'src/state.ts': definition,
    'src/counter.ts': `
      import { useReducer } from 'react';
      import { reducer } from './state';

      export const useCounter = () => useReducer(reducer, 0);
    `,
  });
  const violations = ofRule(findings, 'HB003');
  assert.ok(violations.every(item => item.file === 'src/state.ts'));
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(definition, ['switch (event.type)']),
    messageDetail(violations),
  );
});

test('HB007 rejects mutation of readonly props through known mutating methods', () => {
  const source = `
      import { type ReactNode } from 'react';

      type Props = { readonly items: string[]; readonly title: ReactNode };

      export function List(props: Props): ReactNode {
        props.items.push('mutated');
        return <ul><li>{props.title}</li></ul>;
      }
    `;
  const findings = analyze({ 'src/List.tsx': source });
  const violations = ofRule(findings, 'HB007');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ["props.items.push('mutated')"]),
    messageDetail(violations),
  );
});

test('HB007 rejects writable props types', () => {
  const source = `
      import { type ReactNode } from 'react';

      type Props = { label: string };

      export function Card(props: Props): ReactNode {
        return <div>{props.label}</div>;
      }
    `;
  const findings = analyze({ 'src/Card.tsx': source });
  const violations = ofRule(findings, 'HB007');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['label: string']),
    messageDetail(violations),
  );
});

test('HB007 accepts Readonly<Props> even when the base type has writable fields', () => {
  const findings = analyze({
    'src/Card.tsx': `
      import { type ReactNode } from 'react';

      type Props = { label: string };

      export function Card(props: Readonly<Props>): ReactNode {
        return <div>{props.label}</div>;
      }
    `,
  });
  assert.deepEqual(ofRule(findings, 'HB007'), []);
});

test('HB007 rejects reducer state mutation but allows a local accumulator', () => {
  const source = `
      import { useReducer } from 'react';

      type State = { readonly count: number };
      type Event = { type: 'increment'; amount: number } | { type: 'decrement' };

      function reducer(state: State, event: Event): State {
        const scratch: number[] = [];
        scratch.push(event.type === 'increment' ? event.amount : 0);
        const next: State = state;
        next.count += 1;
        switch (event.type) {
          case 'increment': return { count: next.count + event.amount };
          case 'decrement': return { count: next.count - 1 };
        }
      }

      export const useCounter = () => useReducer(reducer, { count: 0 });
    `;
  const findings = analyze({ 'src/counter.ts': source });
  const violations = ofRule(findings, 'HB007');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['next.count += 1']),
    messageDetail(violations),
  );
});

test('HB007 requires readonly reducer state types', () => {
  const source = `
      import { useReducer } from 'react';

      type State = { count: number };
      type Event = { type: 'increment' } | { type: 'decrement' };

      function reducer(state: State, event: Event): State {
        switch (event.type) {
          case 'increment': return { count: state.count + 1 };
          case 'decrement': return { count: state.count - 1 };
        }
      }

      export const useCounter = () => useReducer(reducer, { count: 0 });
    `;
  const findings = analyze({ 'src/store.ts': source });
  const violations = ofRule(findings, 'HB007');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['type State = { count: number }']),
    messageDetail(violations),
  );
});

test('HB007 rejects mutation of useReducer state returned to a component', () => {
  const source = `
      import { useReducer, type ReactNode } from 'react';

      type State = { readonly count: number };
      type Event = { type: 'increment' } | { type: 'decrement' };

      function reducer(state: State, event: Event): State {
        switch (event.type) {
          case 'increment': return { count: state.count + 1 };
          case 'decrement': return { count: state.count - 1 };
        }
      }

      export function Counter(): ReactNode {
        const [state, dispatch] = useReducer(reducer, { count: 0 });
        state.count += 1;
        return <button type="button" onClick={() => dispatch({ type: 'increment' })}>{state.count}</button>;
      }
    `;
  const findings = analyze({ 'src/Counter.tsx': source });
  const violations = ofRule(findings, 'HB007');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['state.count += 1']),
    messageDetail(violations),
  );
});

test('HB007 allows local component accumulators', () => {
  const findings = analyze({
    'src/Tags.tsx': `
      import { type ReactNode } from 'react';

      export function Tags(): ReactNode {
        const tags: string[] = [];
        tags.push('x');
        return <span>{tags.join(',')}</span>;
      }
    `,
  });
  assert.deepEqual(ofRule(findings, 'HB007'), []);
});

test('HB007 rejects mutation of destructured props through aliases', () => {
  const source = `
      import { type ReactNode } from 'react';

      type Props = Readonly<{ items: string[] }>;

      export function Row({ items }: Props): ReactNode {
        items.push('x');
        return <span>{items.length}</span>;
      }
    `;
  const findings = analyze({ 'src/Row.tsx': source });
  const violations = ofRule(findings, 'HB007');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ["items.push('x')"]),
    messageDetail(violations),
  );
});

test('HB003 accepts reducer-body and parameter discriminant aliases', () => {
  const destructured = `
      import { useReducer } from 'react';

      type Event = { type: 'open' } | { type: 'close' };

      function reducer(state: number, event: Event): number {
        const { type } = event;
        switch (type) {
          case 'open': return state + 1;
          case 'close': return state - 1;
        }
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const renamed = `
      import { useReducer } from 'react';

      type Event = { type: 'open' } | { type: 'close' };

      function reducer(state: number, event: Event): number {
        const { type: tag } = event;
        switch (tag) {
          case 'open': return state + 1;
          case 'close': return state - 1;
        }
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const property = `
      import { useReducer } from 'react';

      type Event = { type: 'open' } | { type: 'close' };

      function reducer(state: number, event: Event): number {
        const tag = event.type;
        switch (tag) {
          case 'open': return state + 1;
          case 'close': return state - 1;
        }
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const element = `
      import { useReducer } from 'react';

      type Event = { type: 'open' } | { type: 'close' };

      function reducer(state: number, event: Event): number {
        const tag = event['type'];
        switch (tag) {
          case 'open': return state + 1;
          case 'close': return state - 1;
        }
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const parameter = `
      import { useReducer } from 'react';

      type Event = { type: 'open' } | { type: 'close' };

      function reducer(state: number, { type: tag }: Event): number {
        switch (tag) {
          case 'open': return state + 1;
          case 'close': return state - 1;
        }
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const findings = analyze({
    'src/alias-destructured.ts': destructured,
    'src/alias-renamed.ts': renamed,
    'src/alias-property.ts': property,
    'src/alias-element.ts': element,
    'src/alias-parameter.ts': parameter,
  });
  assert.deepEqual(findings, [], messageDetail(findings));
});

test('HB003 rejects a discriminant alias switch that misses a variant', () => {
  const source = `
      import { useReducer } from 'react';

      type Event = { type: 'open' } | { type: 'close' };

      function reducer(state: number, event: Event): number {
        const { type: tag } = event;
        switch (tag) {
          case 'open': return state + 1;
        }
        return state;
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const findings = analyze({ 'src/alias-missing.ts': source });
  const violations = ofRule(findings, 'HB003');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['switch (tag)']),
    messageDetail(violations),
  );
});

test('HB003 does not accept switches on other objects, shadowed names, or reassigned aliases', () => {
  const otherObject = `
      import { useReducer } from 'react';

      type Event = { type: 'open' } | { type: 'close' };

      function reducer(state: number, event: Event): number {
        const command = { type: 'open' as 'open' | 'close' };
        switch (command.type) {
          case 'open': return state + 1;
          case 'close': return state - 1;
        }
        return state;
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const otherAlias = `
      import { useReducer } from 'react';

      type Event = { type: 'open' } | { type: 'close' };

      function reducer(state: number, event: Event): number {
        const other = { type: 'open' as 'open' | 'close' };
        const tag = other.type;
        switch (tag) {
          case 'open': return state + 1;
          case 'close': return state - 1;
        }
        return state;
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const shadowed = `
      import { useReducer } from 'react';

      type Event = { type: 'open' } | { type: 'close' };

      function reducer(state: number, event: Event): number {
        const helper = (event: { type: 'open' | 'close' }): number => {
          switch (event.type) {
            case 'open': return state + 1;
            case 'close': return state - 1;
          }
        };
        return helper({ type: 'open' });
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const reassigned = `
      import { useReducer } from 'react';

      type Event = { type: 'open' } | { type: 'close' };

      function reducer(state: number, event: Event): number {
        let tag = event.type;
        tag = 'open';
        switch (tag) {
          case 'open': return state + 1;
          case 'close': return state - 1;
        }
        return state;
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const fixtures: Readonly<Record<string, string>> = {
    'src/other-object.ts': otherObject,
    'src/other-alias.ts': otherAlias,
    'src/shadowed.ts': shadowed,
    'src/reassigned.ts': reassigned,
  };
  const findings = analyze(fixtures);
  for (const [file, source] of Object.entries(fixtures)) {
    const violations = ofRule(findings.filter(item => item.file === file), 'HB003');
    assert.deepEqual(
      findingLines(violations),
      fixtureLines(source, ['function reducer(state: number, event: Event)']),
      `${file}\n${messageDetail(violations)}`,
    );
  }
});

test('HB003 checks the aliased switch rather than unrelated switches in the same reducer', () => {
  const source = `
      import { useReducer } from 'react';

      type Event = { type: 'open' } | { type: 'close' };

      function reducer(state: number, event: Event): number {
        const command = { type: 'open' as 'open' | 'close' };
        switch (command.type) {
          case 'open': return state + 1;
          case 'close': return state - 1;
        }
        const { type: tag } = event;
        switch (tag) {
          case 'open': return state + 1;
        }
        return state;
      }

      export const useCounter = () => useReducer(reducer, 0);
    `;
  const findings = analyze({ 'src/alias-and-unrelated.ts': source });
  const violations = ofRule(findings, 'HB003');
  assert.deepEqual(
    findingLines(violations),
    fixtureLines(source, ['switch (tag)']),
    messageDetail(violations),
  );
});

test('annotated adapter accepts consecutive line slots and a block-scoped never default', () => {
  const findings = analyze({
    'hooks/effects/useConnected.ts': `
      import { useEffect, useReducer } from 'react';
      type Event = { readonly type: 'online' } | { readonly type: 'offline' };
      function reducer(state: boolean, event: Event): boolean {
        switch (event.type) {
          case 'online': return true;
          case 'offline': return false;
          default: {
            const unreachable: never = event;
            return unreachable;
          }
        }
      }
      export function useConnected(): boolean {
        const [connected, dispatch] = useReducer(reducer, true);
        // @effect-external: browser online events
        // @effect-setup: install one event listener
        // @effect-cleanup: remove the same listener on unmount
        useEffect(() => {
          const online = () => dispatch({ type: 'online' });
          window.addEventListener('online', online);
          return () => window.removeEventListener('online', online);
        }, []);
        return connected;
      }
    `,
  });
  assert.deepEqual(findings.filter(row => row.ruleId === 'HB002' || row.ruleId === 'HB003'), []);
});

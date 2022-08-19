// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { cloneDeep, isEqual, union } from 'lodash';
import { Event, EventEmitter } from 'vscode';
import { traceVerbose } from '../../../../logging';
import { PythonEnvKind } from '../../info';
import { areSameEnv } from '../../info/env';
import { sortExtensionSource, sortKindFunction } from '../../info/envKind';
import {
    BasicEnvInfo,
    CompositeEnvInfo,
    convertBasicToComposite,
    ILocator,
    IPythonEnvsIterator,
    isProgressEvent,
    ProgressNotificationEvent,
    ProgressReportStage,
    PythonEnvUpdatedEvent,
    PythonLocatorQuery,
} from '../../locator';
import { PythonEnvsChangedEvent } from '../../watcher';

/**
 * Combines duplicate environments received from the incoming locator into one and passes on unique environments
 */
export class PythonEnvsReducer implements ILocator<CompositeEnvInfo> {
    public get onChanged(): Event<PythonEnvsChangedEvent> {
        return this.parentLocator.onChanged;
    }

    public addNewLocator = this.parentLocator.addNewLocator;

    constructor(private readonly parentLocator: ILocator<BasicEnvInfo>) {}

    public iterEnvs(query?: PythonLocatorQuery): IPythonEnvsIterator<CompositeEnvInfo> {
        const didUpdate = new EventEmitter<PythonEnvUpdatedEvent<CompositeEnvInfo> | ProgressNotificationEvent>();
        const incomingIterator = this.parentLocator.iterEnvs(query);
        const iterator = iterEnvsIterator(incomingIterator, didUpdate);
        iterator.onUpdated = didUpdate.event;
        return iterator;
    }
}

async function* iterEnvsIterator(
    iterator: IPythonEnvsIterator<BasicEnvInfo>,
    didUpdate: EventEmitter<PythonEnvUpdatedEvent<CompositeEnvInfo> | ProgressNotificationEvent>,
): IPythonEnvsIterator<CompositeEnvInfo> {
    const state = {
        done: false,
        pending: 0,
    };
    const seen: CompositeEnvInfo[] = [];

    if (iterator.onUpdated !== undefined) {
        const listener = iterator.onUpdated((event) => {
            state.pending += 1;
            if (isProgressEvent(event)) {
                if (event.stage === ProgressReportStage.discoveryFinished) {
                    state.done = true;
                    listener.dispose();
                } else {
                    didUpdate.fire(event);
                }
            } else if (event.update === undefined) {
                throw new Error(
                    'Unsupported behavior: `undefined` environment updates are not supported from downstream locators in reducer',
                );
            } else if (seen[event.index] !== undefined) {
                const oldEnv = seen[event.index];
                seen[event.index] = convertBasicToComposite(event.update);
                didUpdate.fire({ index: event.index, old: oldEnv, update: seen[event.index] });
            } else {
                // This implies a problem in a downstream locator
                traceVerbose(`Expected already iterated env, got ${event.old} (#${event.index})`);
            }
            state.pending -= 1;
            checkIfFinishedAndNotify(state, didUpdate);
        });
    } else {
        didUpdate.fire({ stage: ProgressReportStage.discoveryStarted });
    }

    let result = await iterator.next();
    while (!result.done) {
        const currEnv = convertBasicToComposite(result.value);
        const oldIndex = seen.findIndex((s) => areSameEnv(s, currEnv));
        if (oldIndex !== -1) {
            resolveDifferencesInBackground(oldIndex, currEnv, state, didUpdate, seen).ignoreErrors();
        } else {
            // We haven't yielded a matching env so yield this one as-is.
            yield currEnv;
            seen.push(currEnv);
        }
        result = await iterator.next();
    }
    if (iterator.onUpdated === undefined) {
        state.done = true;
        checkIfFinishedAndNotify(state, didUpdate);
    }
}

async function resolveDifferencesInBackground(
    oldIndex: number,
    newEnv: CompositeEnvInfo,
    state: { done: boolean; pending: number },
    didUpdate: EventEmitter<PythonEnvUpdatedEvent<CompositeEnvInfo> | ProgressNotificationEvent>,
    seen: CompositeEnvInfo[],
) {
    state.pending += 1;
    // It's essential we increment the pending call count before any asynchronus calls in this method.
    // We want this to be run even when `resolveInBackground` is called in background.
    const oldEnv = seen[oldIndex];
    const merged = resolveEnvCollision(oldEnv, newEnv);
    if (!isEqual(oldEnv, merged)) {
        seen[oldIndex] = merged;
        didUpdate.fire({ index: oldIndex, old: oldEnv, update: merged });
    }
    state.pending -= 1;
    checkIfFinishedAndNotify(state, didUpdate);
}

/**
 * When all info from incoming iterator has been received and all background calls finishes, notify that we're done
 * @param state Carries the current state of progress
 * @param didUpdate Used to notify when finished
 */
function checkIfFinishedAndNotify(
    state: { done: boolean; pending: number },
    didUpdate: EventEmitter<PythonEnvUpdatedEvent<CompositeEnvInfo> | ProgressNotificationEvent>,
) {
    if (state.done && state.pending === 0) {
        didUpdate.fire({ stage: ProgressReportStage.discoveryFinished });
        didUpdate.dispose();
    }
}

function resolveEnvCollision(oldEnv: CompositeEnvInfo, newEnv: CompositeEnvInfo): CompositeEnvInfo {
    const [env] = sortEnvInfoByPriority(oldEnv, newEnv);
    const merged = cloneDeep(env);
    merged.source = union(oldEnv.source ?? [], newEnv.source ?? []);
    merged.kind = union(merged.kind, oldEnv.kind, newEnv.kind);
    return merged;
}

/**
 * Selects an environment based on the environment selection priority. This should
 * match the priority in the environment identifier.
 */
function sortEnvInfoByPriority(...envs: CompositeEnvInfo[]): CompositeEnvInfo[] {
    return envs.sort((a: CompositeEnvInfo, b: CompositeEnvInfo) => {
        const kindDiff = sortKindFunction(getTopKind(a.kind), getTopKind(b.kind));
        if (kindDiff !== 0) {
            return kindDiff;
        }
        return sortExtensionSource(a.extensionId, b.extensionId);
    });
}

function getTopKind(kinds: PythonEnvKind[]) {
    return kinds.sort(sortKindFunction)[0];
}

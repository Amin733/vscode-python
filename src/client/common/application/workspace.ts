// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { injectable } from 'inversify';
import * as path from 'path';
import {
    CancellationToken,
    ConfigurationChangeEvent,
    ConfigurationScope,
    Event,
    FileSystemWatcher,
    GlobPattern,
    Uri,
    workspace,
    WorkspaceConfiguration,
    WorkspaceFolder,
    WorkspaceFoldersChangeEvent,
} from 'vscode';
import { Resource } from '../types';
import { getOSType, OSType } from '../utils/platform';
import { IWorkspaceService } from './types';

@injectable()
export class WorkspaceService implements IWorkspaceService {
    public get onDidChangeConfiguration(): Event<ConfigurationChangeEvent> {
        return workspace.onDidChangeConfiguration;
    }
    public get rootPath(): string | undefined {
        return Array.isArray(workspace.workspaceFolders) && workspace.workspaceFolders.length > 0
            ? workspace.workspaceFolders[0].uri.fsPath
            : undefined;
    }
    public get workspaceFolders(): readonly WorkspaceFolder[] | undefined {
        return workspace.workspaceFolders;
    }
    public get onDidChangeWorkspaceFolders(): Event<WorkspaceFoldersChangeEvent> {
        return workspace.onDidChangeWorkspaceFolders;
    }
    public get hasWorkspaceFolders() {
        return Array.isArray(workspace.workspaceFolders) && workspace.workspaceFolders.length > 0;
    }
    public get workspaceFile() {
        return workspace.workspaceFile;
    }
    public getConfiguration(section?: string, scope?: ConfigurationScope): WorkspaceConfiguration {
        return workspace.getConfiguration(section, scope || null);
    }
    public getWorkspaceFolder(uri: Resource): WorkspaceFolder | undefined {
        return uri ? workspace.getWorkspaceFolder(uri) : undefined;
    }
    public asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string {
        return workspace.asRelativePath(pathOrUri, includeWorkspaceFolder);
    }
    public createFileSystemWatcher(
        globPattern: GlobPattern,
        ignoreCreateEvents?: boolean,
        ignoreChangeEvents?: boolean,
        ignoreDeleteEvents?: boolean,
    ): FileSystemWatcher {
        return workspace.createFileSystemWatcher(
            globPattern,
            ignoreCreateEvents,
            ignoreChangeEvents,
            ignoreDeleteEvents,
        );
    }
    public findFiles(
        include: GlobPattern,
        exclude?: GlobPattern,
        maxResults?: number,
        token?: CancellationToken,
    ): Thenable<Uri[]> {
        const excludePattern = exclude === undefined ? this.searchExcludes : exclude;
        return workspace.findFiles(include, excludePattern, maxResults, token);
    }
    public getWorkspaceFolderIdentifier(resource: Resource, defaultValue: string = ''): string {
        const workspaceFolder = resource ? workspace.getWorkspaceFolder(resource) : undefined;
        return workspaceFolder
            ? path.normalize(
                  getOSType() === OSType.Windows
                      ? workspaceFolder.uri.fsPath.toUpperCase()
                      : workspaceFolder.uri.fsPath,
              )
            : defaultValue;
    }

    private get searchExcludes() {
        const searchExcludes = this.getConfiguration('search.exclude');
        const enabledSearchExcludes = Object.keys(searchExcludes).filter((key) => searchExcludes.get(key) === true);
        return `{${enabledSearchExcludes.join(',')}}`;
    }
}

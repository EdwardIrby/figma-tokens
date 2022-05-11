import * as GitInterfaces from 'azure-devops-node-api/interfaces/GitInterfaces';
import compact from 'just-compact';
import { GitStorageMetadata, GitTokenStorage } from './GitTokenStorage';
import { RemoteTokenStorageFile, RemoteTokenStorageSingleTokenSetFile, RemoteTokenStorageThemesFile } from './RemoteTokenStorage';
import { ContextObject } from '@/types/api';

const apiVersion = 'api-version=6.0';

interface FetchGit {
  body?: string
  gitResource: 'refs' | 'items' | 'pushes'
  method?: 'GET' | 'POST'
  orgUrl?: string
  params?: Record<string, string | boolean>
  projectId?: string
  repositoryId: string
  token: string
}

type PostPushesArgs = {
  branch: string,
  changes: Record<string, any>,
  commitMessage?: string,
  oldObjectId?: string,
};

enum ChangeType {
  add = 'add',
  edit = 'edit',
}

enum ContentType {
  rawtext = 'rawtext',
}

export class ADOTokenStorage extends GitTokenStorage {
  protected orgUrl: string;

  protected projectId?: string;

  constructor({
    baseUrl: orgUrl = '',
    secret,
    id: repositoryId,
    branch = 'main',
    filePath = '/',
    name: projectId,
  }: ContextObject) {
    super(secret, '', repositoryId, orgUrl);
    this.orgUrl = orgUrl;
    this.projectId = projectId;
    super.selectBranch(branch);
    super.changePath(filePath);
  }

  public async fetchGit({
    body,
    gitResource,
    orgUrl,
    params,
    projectId,
    repositoryId,
    token,
    method = 'GET',
  }: FetchGit): Promise<Response> {
    const paramString = params
      ? Object.entries(params).reduce<string>((acc, [key, value]) => `${acc}${key}=${value}&`, '') + apiVersion
      : apiVersion;
    const input = `${orgUrl}/${projectId ? `${projectId}/` : ''}_apis/git/repositories/${repositoryId}/${gitResource}?${paramString}`;
    const res = await fetch(
      input,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${btoa(`:${token}`)}`,
        },
        body,
      },
    );
    return res;
  }

  public async canWrite(): Promise<boolean> {
    const { status } = await this.fetchGit({
      gitResource: 'refs',
      orgUrl: this.orgUrl,
      params: {
        filter: 'heads',
      },
      projectId: this.projectId,
      repositoryId: this.repository,
      token: this.secret,
    });
    return status === 200;
  }

  private async getRefs(params:Record<string, string>): Promise<{ count: number, value: GitInterfaces.GitRef[] }> {
    try {
      const response = await this.fetchGit({
        gitResource: 'refs',
        orgUrl: this.orgUrl,
        params,
        projectId: this.projectId,
        repositoryId: this.repository,
        token: this.secret,
      });
      return await response.json();
    } catch (e) {
      console.log(e);
      return { count: 0, value: [] };
    }
  }

  private async postRefs(body: Record<string, string>) {
    try {
      const response = await this.fetchGit({
        gitResource: 'refs',
        orgUrl: this.orgUrl,
        body: JSON.stringify(body),
        projectId: this.projectId,
        repositoryId: this.repository,
        token: this.secret,
      });
      return await response.json();
    } catch (e) {
      console.log(e);
      return { count: 0, value: [] };
    }
  }

  public async fetchBranches() {
    const { value } = await this.getRefs({ filter: 'heads' });
    const branches = [];
    for (const val of value) {
      if (val.name) {
        branches.push(val.name.replace(/^refs\/heads\//, ''));
      }
    }
    return branches;
  }

  public async createBranch(branch: string, source: string): Promise<boolean> {
    const { value } = await this.getRefs({ filter: `heads/${source}` });
    if (value[0].objectId) {
      const response = await this.postRefs({
        name: `1refs/heads/${branch}`,
        oldObjectId: '0000000000000000000000000000000000000000',
        newObjectId: value[0].objectId,
      });
      const { value: { success } } = response;
      return Boolean(success);
    }
    return false;
  }

  private async getOldObjectId(branch:string, shouldCreateBranch: boolean) {
    const { value } = await this.getRefs({ filter: 'heads' });
    const branches = new Map<string, GitInterfaces.GitRef>();
    for (const val of value) {
      if (val.name) {
        branches.set(val.name.replace(/^refs\/heads\//, ''), val);
      }
    }

    return shouldCreateBranch ? branches.get(this.branch)?.objectId : branches.get(branch)?.objectId;
  }

  private itemsDefault(): Omit<FetchGit, 'body' | 'params'> {
    return {
      gitResource: 'items',
      orgUrl: this.orgUrl,
      projectId: this.projectId,
      repositoryId: this.repository,
      token: this.secret,
    };
  }

  private async getItem(path: string = this.path): Promise<Record<string, any>> {
    try {
      const response = await this.fetchGit({
        ...this.itemsDefault(),
        params: {
          path,
          'versionDescriptor.version': this.branch,
          'versionDescriptor.versionType': 'branch',
          includeContent: true,
        },
      });
      return await response.json();
    } catch (e) {
      console.log(e);
      return {};
    }
  }

  private async getItems(): Promise<{ count: number, value: GitInterfaces.GitItem[] }> {
    try {
      const response = await this.fetchGit({
        ...this.itemsDefault(),
        params: {
          scopePath: this.path.replace(/[^/]+\.json$/, ''),
          recursionLevel: 'full',
          'versionDescriptor.version': this.branch,
          'versionDescriptor.versionType': 'branch',
        },
      });
      return await response.json();
    } catch (e) {
      console.log(e);
      return { count: 0, value: [] };
    }
  }

  public async read(): Promise<RemoteTokenStorageFile<GitStorageMetadata>[]> {
    try {
      if (this.flags.multiFileEnabled) {
        const { value } = await this.getItems();
        const jsonFiles = value
          .filter((file) => (file.path?.endsWith('.json')))
          .sort((a, b) => (
            (a.path && b.path) ? a.path.localeCompare(b.path) : 0
          ));

        if (!jsonFiles.length) return [];

        const jsonFileContents = await Promise.all(
          jsonFiles.map(async ({ path }) => {
            const res = await this.getItem(path);
            return res;
          }),
        );
        return compact(jsonFileContents.map<RemoteTokenStorageFile<GitStorageMetadata> | null>((fileContent, index) => {
          const { path } = jsonFiles[index];
          if (fileContent) {
            const name = path?.replace(/[^/]+\.json$/, '');
            const { $themes = [], ...data } = fileContent;

            if (name === '$themes') {
              return {
                path,
                type: 'themes',
                data: $themes,
              } as RemoteTokenStorageThemesFile;
            }

            return {
              path,
              name,
              type: 'tokenSet',
              data,
            } as RemoteTokenStorageSingleTokenSetFile;
          }

          return null;
        }));
      }
      const { $themes = [], ...data } = await this.getItem();
      return [
        {
          type: 'themes',
          path: `${this.path}/$themes.json`,
          data: $themes,
        },
        ...Object.entries(data).map<RemoteTokenStorageFile<GitStorageMetadata>>(([name, tokenSet]) => ({
          name,
          type: 'tokenSet',
          path: `${this.path}/${name}.json`,
          data: tokenSet,
        })),
      ];
    } catch (e) {
      console.log(e);
    }
    return [];
  }

  private async postPushes({
    branch, changes, commitMessage = 'Commit from Figma', oldObjectId,
  }: PostPushesArgs): Promise<GitInterfaces.GitPush> {
    const response = await this.fetchGit({
      body: JSON.stringify({
        refUpdates: [
          {
            name: `refs/heads/${branch}`,
            oldObjectId,
          },
        ],
        commits: [
          {
            comment: commitMessage,
            changes,
          },
        ],
      }),
      gitResource: 'pushes',
      method: 'POST',
      orgUrl: this.orgUrl,
      projectId: this.projectId,
      repositoryId: this.repository,
      token: this.secret,
    });
    return response;
  }

  public async writeChangeset(changeset: Record<string, string>, message: string, branch: string, shouldCreateBranch: boolean = false): Promise<boolean> {
    console.log(branch);
    const oldObjectId = await this.getOldObjectId(branch, shouldCreateBranch);
    const { value } = await this.getItems();
    const tokensOnRemote = value.map((val) => val.path);
    const changes = Object.entries(changeset)
      .map(([path, content]) => ({
        changeType: tokensOnRemote.includes(path.startsWith('/') ? path : `/${path}`) ? ChangeType.edit : ChangeType.add,
        item: {
          path: `/${path}`,
        },
        newContent: {
          content,
          contentType: ContentType.rawtext,
        },
      }));
    const response = await this.postPushes({
      branch,
      changes,
      commitMessage: message,
      oldObjectId,
    });

    return !!response;
  }
}

import { useDispatch, useSelector } from 'react-redux';
import React from 'react';
import { Dispatch } from '@/app/store';
import { MessageToPluginTypes } from '@/types/messages';
import useConfirm from '@/app/hooks/useConfirm';
import usePushDialog from '@/app/hooks/usePushDialog';
import { ContextObject } from '@/types/api';
import { notifyToUI, postToFigma } from '../../../../plugin/notifiers';
import { FeatureFlags } from '@/utils/featureFlags';
import {
  featureFlagsSelector, localApiStateSelector, tokensSelector, themesListSelector,
} from '@/selectors';
import { ADOTokenStorage } from '@/storage/ADOTokenStorage';
import { isEqual } from '@/utils/isEqual';
import { RemoteTokenStorageData } from '@/storage/RemoteTokenStorage';
import { GitStorageMetadata } from '@/storage/GitTokenStorage';

export const useADO = () => {
  const tokens = useSelector(tokensSelector);
  const themes = useSelector(themesListSelector);
  const localApiState = useSelector(localApiStateSelector);
  const featureFlags = useSelector(featureFlagsSelector);
  const dispatch = useDispatch<Dispatch>();
  const { confirm } = useConfirm();
  const { pushDialog } = usePushDialog();

  const storageClientFactory = React.useCallback((context: ContextObject) => {
    const storageClient = new ADOTokenStorage(context);
    if (context.filePath) storageClient.changePath(context.filePath);
    if (context.branch) storageClient.selectBranch(context.branch);
    if (featureFlags?.gh_mfs_enabled) storageClient.enableMultiFile();
    return storageClient;
  }, [featureFlags]);

  const askUserIfPull = React.useCallback(async () => {
    const confirmResult = await confirm({
      text: 'Pull from Ado?',
      description: 'Your repo already contains tokens, do you want to pull these now?',
    });
    if (confirmResult === false) return false;
    return confirmResult.result;
  }, [confirm]);

  const pushTokensToADO = React.useCallback(async (context: ContextObject) => {
    const storage = storageClientFactory(context);
    const content = await storage.retrieve();

    if (
      content
      && isEqual(content.tokens, tokens)
      && isEqual(content.themes, themes)
    ) {
      notifyToUI('Nothing to commit');
      return false;
    }

    dispatch.uiState.setLocalApiState({ ...context });

    const pushSettings = await pushDialog();
    if (pushSettings) {
      const { commitMessage, customBranch } = pushSettings;
      try {
        await storage.save({
          themes,
          tokens,
          metadata: { commitMessage },
        });

        dispatch.uiState.setLocalApiState({ ...localApiState, branch: customBranch });
        dispatch.uiState.setApiData({ ...context, branch: customBranch });

        pushDialog('success');
        return true;
      } catch (e) {
        console.log('Error pushing to ADO', e);
      }
    }
    return false;
  }, [
    dispatch,
    storageClientFactory,
    tokens,
    themes,
    pushDialog,
    localApiState,
  ]);

  const checkAndSetAccess = React.useCallback(async (context: ContextObject) => {
    const storage = storageClientFactory(context);
    const hasWriteAccess = await storage.canWrite();
    dispatch.tokenState.setEditProhibited(!hasWriteAccess);
  }, [dispatch, storageClientFactory]);

  const pullTokensFromADO = React.useCallback(async (context: ContextObject, receivedFeatureFlags?: FeatureFlags | undefined) => {
    const storage = storageClientFactory(context);
    if (receivedFeatureFlags?.gh_mfs_enabled) storage.enableMultiFile();

    await checkAndSetAccess(context);

    try {
      const content = await storage.retrieve();

      if (content) {
        return content;
      }
    } catch (e) {
      console.log('Error', e);
    }
    return null;
  }, [
    checkAndSetAccess,
    storageClientFactory,
  ]);

  const syncTokensWithADO = React.useCallback(async (context: ContextObject): Promise<RemoteTokenStorageData<GitStorageMetadata> | null> => {
    try {
      const storage = storageClientFactory(context);
      const branches = await storage.fetchBranches();

      if (branches.length === 0) {
        return null;
      }

      const content = await storage.retrieve();

      if (content) {
        if (
          !isEqual(content.tokens, tokens)
          || !isEqual(content.themes, themes)
        ) {
          const userDecision = await askUserIfPull();
          if (userDecision) {
            dispatch.tokenState.setLastSyncedState(JSON.stringify([content.tokens, content.themes], null, 2));
            dispatch.tokenState.setTokenData({
              values: content.tokens,
              themes: content.themes,
            });
            notifyToUI('Pulled tokens from ADO');
          }
        }
        return content;
      }
      await pushTokensToADO(context);
      return content;
    } catch (e) {
      notifyToUI('Error syncing with ADO, check credentials', { error: true });
      console.log('Error', e);
      return null;
    }
  }, [
    askUserIfPull,
    dispatch,
    pushTokensToADO,
    storageClientFactory,
    themes,
    tokens,
  ]);

  const addNewADOCredentials = React.useCallback(
    async (context: ContextObject): Promise<RemoteTokenStorageData<GitStorageMetadata> | null> => {
      const data = await syncTokensWithADO(context);

      if (data) {
        postToFigma({
          type: MessageToPluginTypes.CREDENTIALS,
          ...context,
        });
        if (data?.tokens) {
          dispatch.tokenState.setLastSyncedState(JSON.stringify([data.tokens, data.themes], null, 2));
          dispatch.tokenState.setTokenData({
            values: data.tokens,
            themes: data.themes,
          });
        } else {
          notifyToUI('No tokens stored on remote');
        }
      } else {
        return null;
      }

      return {
        tokens: data.tokens ?? tokens,
        themes: data.themes ?? themes,
        metadata: {},
      };
    },
    [
      dispatch,
      tokens,
      themes,
      syncTokensWithADO,
    ],
  );

  const fetchADOBranches = React.useCallback(async (context: ContextObject) => {
    const storage = storageClientFactory(context);
    const branches = await storage.fetchBranches();
    return branches;
  }, [storageClientFactory]);

  const createADOBranch = React.useCallback((context: ContextObject, newBranch: string, source?: string) => {
    const storage = storageClientFactory(context);
    return storage.createBranch(newBranch, source);
  }, [storageClientFactory]);

  return React.useMemo(() => ({
    addNewADOCredentials,
    syncTokensWithADO,
    pullTokensFromADO,
    pushTokensToADO,
    fetchADOBranches,
    createADOBranch,
  }), [
    addNewADOCredentials,
    syncTokensWithADO,
    pullTokensFromADO,
    pushTokensToADO,
    fetchADOBranches,
    createADOBranch,
  ]);
};
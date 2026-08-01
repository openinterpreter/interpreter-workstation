import { useEffect, useState } from 'react';
import type { AgentActivityState } from '../../shared/utils/agentAttention';
import { getAgentActivitySnapshot, subscribeAgentActivity } from '../stores/agentActivityStore';

export function useAgentActivityMap(): Map<string, AgentActivityState> {
  const [activityMap, setActivityMap] = useState(() => getAgentActivitySnapshot());

  useEffect(() => {
    return subscribeAgentActivity(() => {
      setActivityMap(getAgentActivitySnapshot());
    });
  }, []);

  return activityMap;
}

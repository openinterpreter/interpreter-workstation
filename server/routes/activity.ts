import { Router, Request, Response } from 'express';
import {
  recordFileOpen,
  recordSkillUsage,
  recordCardClick,
  recordAction,
  getRecentFiles,
  getFrequentFiles,
  getFrequentSkills,
  getCardClicks,
  getFrequentActions,
  getActionCounts,
} from '../activityStore';

const router = Router();

// Record a file open (debounced on the client side for noisy events).
router.post('/file-open', async (req: Request, res: Response) => {
  try {
    const { path } = req.body ?? {};
    if (typeof path !== 'string' || !path) {
      return res.status(400).json({ error: 'path is required' });
    }
    await recordFileOpen(path);
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to record file open' });
  }
});

// Record a skill insertion / invocation.
router.post('/skill-use', async (req: Request, res: Response) => {
  try {
    const { skillId, name } = req.body ?? {};
    if (typeof skillId !== 'string' || !skillId) {
      return res.status(400).json({ error: 'skillId is required' });
    }
    await recordSkillUsage(skillId, typeof name === 'string' ? name : skillId);
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to record skill use' });
  }
});

// Record a click on a new-tab suggestion card.
router.post('/card-click', async (req: Request, res: Response) => {
  try {
    const { cardId } = req.body ?? {};
    if (typeof cardId !== 'string' || !cardId) {
      return res.status(400).json({ error: 'cardId is required' });
    }
    await recordCardClick(cardId);
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to record card click' });
  }
});

// Record a coarse user action (e.g. created-note, sent-prompt, started-chat).
router.post('/action', async (req: Request, res: Response) => {
  try {
    const { actionId } = req.body ?? {};
    if (typeof actionId !== 'string' || !actionId) {
      return res.status(400).json({ error: 'actionId is required' });
    }
    await recordAction(actionId);
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to record action' });
  }
});

// Aggregated signals the new tab reads at mount time.
router.get('/signals', async (_req: Request, res: Response) => {
  try {
    const [recentFiles, frequentFiles, frequentSkills, cards, actions] = await Promise.all([
      getRecentFiles(20),
      getFrequentFiles(20),
      getFrequentSkills(10),
      getCardClicks(),
      getFrequentActions(30),
    ]);
    const actionCounts = await getActionCounts();
    res.json({
      recentFiles,
      frequentFiles,
      frequentSkills,
      cardClicks: cards,
      frequentActions: actions,
      actionCounts,
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to load signals' });
  }
});

export default router;

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { AuthSignIn } from '../auth/AuthSignIn';
import { AccountInfo } from '../auth/AccountInfo';
import { getUserName, setUserName } from '../../api';
import { Check, PencilLine, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { SettingsActionButton, SettingsRow } from './SettingsSection';

function DisplayNameControl() {
  const { t } = useTranslation();
  const [name, setName] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadName() {
      let nextUserName: string | null = null;
      try {
        const { userName } = await getUserName();
        nextUserName = userName;
      } catch (error) {
        console.error('Error loading user name:', error);
      }
      setName(nextUserName);
      setEditValue(nextUserName || '');
      setLoading(false);
    }
    loadName();
  }, []);

  const handleSave = useCallback(async () => {
    if (!editValue.trim()) return;
    setIsSaving(true);
    try {
      await setUserName(editValue.trim());
      setName(editValue.trim());
      setIsEditing(false);
    } catch (error) {
      console.error('Error saving user name:', error);
    }
    setIsSaving(false);
  }, [editValue]);

  const handleCancel = useCallback(() => {
    setEditValue(name || '');
    setIsEditing(false);
  }, [name]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  }, [handleSave, handleCancel]);

  if (loading) {
    return <span className="text-ui-sm text-muted-foreground">{t('common.loading')}</span>;
  }

  if (isEditing) {
    return (
      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
          className="h-8 w-44"
        />
        <Button
          variant="utility"
          size="sm"
          onClick={handleSave}
          disabled={!editValue.trim() || isSaving}
        >
          <Check className="size-3.5" />
          {t('common.save')}
        </Button>
        <Button
          variant="utility"
          size="sm"
          onClick={handleCancel}
          disabled={isSaving}
        >
          <X className="size-3.5" />
          {t('common.cancel')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-ui-sm text-foreground">{name || t('settings.account.notSet')}</span>
      <SettingsActionButton
        icon={PencilLine}
        onClick={() => setIsEditing(true)}
      >
        {t('common.edit')}
      </SettingsActionButton>
    </div>
  );
}

export function AccountSectionContent() {
  const { t } = useTranslation();
  const { user, isAuthenticated, loading: authLoading, signOut } = useAuth();

  return (
    <>
      <SettingsRow label={t('settings.account.displayNameLabel')} description={t('settings.account.displayNameDescription')}>
        <DisplayNameControl />
      </SettingsRow>

      <div className="py-[18px]">
        {authLoading ? (
          <div className="text-ui-sm text-muted-foreground">{t('common.loading')}</div>
        ) : isAuthenticated && user ? (
          <AccountInfo user={user} onSignOut={signOut} />
        ) : (
          <AuthSignIn />
        )}
      </div>
    </>
  );
}

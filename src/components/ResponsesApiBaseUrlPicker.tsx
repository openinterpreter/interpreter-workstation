import { useMemo, useRef, useState } from 'react';
import {
  API_BASE_URL_PICKER_INPUT_ID,
  API_BASE_URL_PICKER_EDIT_INPUT_ID,
  API_BASE_URL_PICKER_OPTION_ITEM_ID,
  API_BASE_URL_PICKER_POPOVER_ID,
  API_BASE_URL_PICKER_TRIGGER_ID,
} from '../../shared/element-ids';
import {
  findSupportedResponsesApiBaseUrlOption,
  SUPPORTED_RESPONSES_API_BASE_URLS,
} from '../../shared/types/provider';
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from './ui/combobox';
import { Field, FieldDescription, FieldLabel } from './ui/field';
import { Input } from './ui/input';

interface ResponsesApiBaseUrlPickerProps {
  label: string;
  description?: string;
  baseURL?: string;
  selectedBaseURLId?: string;
  placeholder?: string;
  required?: boolean;
  onBaseURLChange: (baseURL: string) => void;
  onSelectedBaseURLIdChange?: (baseURLId: string) => void;
}

const DEFAULT_BASE_URL = SUPPORTED_RESPONSES_API_BASE_URLS[0].baseURL;
export const CUSTOM_RESPONSES_API_BASE_URL_SELECTION_ID = 'custom';
const CUSTOM_BASE_URL_VALUE = '__custom_base_url__';

function getSelectedOption(baseURL: string | undefined) {
  return findSupportedResponsesApiBaseUrlOption(baseURL) ?? null;
}

function getSelectedOptionById(baseURLId: string | undefined) {
  if (!baseURLId || baseURLId === CUSTOM_RESPONSES_API_BASE_URL_SELECTION_ID) {
    return null;
  }

  return SUPPORTED_RESPONSES_API_BASE_URLS.find((option) => option.id === baseURLId) ?? null;
}

function getSelectedLabel(baseURL: string | undefined, selectedBaseURLId: string | undefined): string {
  if (selectedBaseURLId === CUSTOM_RESPONSES_API_BASE_URL_SELECTION_ID) return 'Custom endpoint';

  const selectedOption = getSelectedOptionById(selectedBaseURLId) ?? getSelectedOption(baseURL);
  if (selectedOption) return selectedOption.label;

  return 'Custom endpoint';
}

export function ResponsesApiBaseUrlPicker({
  label,
  description,
  baseURL,
  selectedBaseURLId,
  placeholder = DEFAULT_BASE_URL,
  required = false,
  onBaseURLChange,
  onSelectedBaseURLIdChange,
}: ResponsesApiBaseUrlPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedOption = selectedBaseURLId === CUSTOM_RESPONSES_API_BASE_URL_SELECTION_ID
    ? null
    : getSelectedOptionById(selectedBaseURLId) ?? getSelectedOption(baseURL);
  const selectedBaseURL = selectedBaseURLId === CUSTOM_RESPONSES_API_BASE_URL_SELECTION_ID
    ? CUSTOM_BASE_URL_VALUE
    : selectedOption?.baseURL ?? CUSTOM_BASE_URL_VALUE;
  const normalizedQuery = query.trim();
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) {
      return SUPPORTED_RESPONSES_API_BASE_URLS;
    }

    const lowerQuery = normalizedQuery.toLowerCase();
    return SUPPORTED_RESPONSES_API_BASE_URLS.filter((option) =>
      option.label.toLowerCase().includes(lowerQuery)
      || option.baseURL.toLowerCase().includes(lowerQuery)
    );
  }, [normalizedQuery]);

  return (
    <Field className="gap-2">
      <FieldLabel>{label}</FieldLabel>
      {description && <FieldDescription>{description}</FieldDescription>}
      <Combobox
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          setQuery('');
        }}
        value={selectedBaseURL}
        onValueChange={(value) => {
          if (!value) {
            return;
          }
          if (value === CUSTOM_BASE_URL_VALUE) {
            onSelectedBaseURLIdChange?.(CUSTOM_RESPONSES_API_BASE_URL_SELECTION_ID);
            onBaseURLChange(baseURL ?? '');
            setQuery('');
            setOpen(false);
            return;
          }
          const nextOption = SUPPORTED_RESPONSES_API_BASE_URLS.find((option) => option.baseURL === value);
          if (nextOption) {
            onSelectedBaseURLIdChange?.(nextOption.id);
          }
          onBaseURLChange(value);
          setQuery('');
          setOpen(false);
        }}
        inputValue={query}
        onInputValueChange={setQuery}
        autoHighlight
      >
        <ComboboxTrigger
          aria-controls={API_BASE_URL_PICKER_POPOVER_ID}
          data-testid={API_BASE_URL_PICKER_TRIGGER_ID}
          className="min-h-8"
        >
          <div className="min-w-0 flex-1 truncate text-foreground">
            {getSelectedLabel(baseURL, selectedBaseURLId)}
          </div>
        </ComboboxTrigger>

        <ComboboxContent
          data-testid={API_BASE_URL_PICKER_POPOVER_ID}
          id={API_BASE_URL_PICKER_POPOVER_ID}
          className="w-[min(32rem,calc(100vw-2rem))] p-0"
          align="start"
          initialFocus={inputRef}
        >
          <div className="space-y-3 p-3">
            <ComboboxInput
              ref={inputRef}
              placeholder="Search providers"
              inputGroupClassName="w-full"
              showTrigger={false}
              data-testid={API_BASE_URL_PICKER_INPUT_ID}
            />

            <ComboboxList className="space-y-1">
              {filteredOptions.map((option) => (
                <ComboboxItem
                  key={option.id}
                  value={option.baseURL}
                  data-testid={API_BASE_URL_PICKER_OPTION_ITEM_ID}
                  data-base-url-id={option.id}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-foreground">{option.label}</div>
                    <div className="truncate text-ui-xs text-muted-foreground">{option.baseURL}</div>
                  </div>
                </ComboboxItem>
              ))}
              <ComboboxItem
                value={CUSTOM_BASE_URL_VALUE}
                data-testid={API_BASE_URL_PICKER_OPTION_ITEM_ID}
                data-base-url-id="custom"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-foreground">Custom endpoint</div>
                  <div className="truncate text-ui-xs text-muted-foreground">
                    {baseURL?.trim() || 'Enter any Responses-compatible base URL'}
                  </div>
                </div>
              </ComboboxItem>
              {filteredOptions.length === 0 && (
                <div className="rounded-control bg-muted/40 px-3 py-4 text-center text-ui-sm text-muted-foreground">
                  No matching base URLs
                </div>
              )}
            </ComboboxList>
          </div>
        </ComboboxContent>
      </Combobox>
      <Input
        type="text"
        value={baseURL || ''}
        onChange={(event) => {
          onSelectedBaseURLIdChange?.(CUSTOM_RESPONSES_API_BASE_URL_SELECTION_ID);
          onBaseURLChange(event.target.value);
        }}
        placeholder={placeholder}
        aria-label={label}
        data-testid={API_BASE_URL_PICKER_EDIT_INPUT_ID}
        required={required}
      />
    </Field>
  );
}

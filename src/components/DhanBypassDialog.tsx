import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, X } from "lucide-react";
import { getDhanBypassKey, setDhanBypassKey, clearDhanBypassKey } from "@/lib/dhanBypass";

interface DhanBypassDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onKeyChange?: (enabled: boolean) => void;
}

export function DhanBypassDialog({ open: controlledOpen, onOpenChange, onKeyChange }: DhanBypassDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [authKey, setAuthKey] = useState("");
  const [isEnabled, setIsEnabled] = useState(false);

  // Use controlled or internal open state
  const open = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setOpen = onOpenChange || setInternalOpen;

  useEffect(() => {
    const key = getDhanBypassKey();
    if (key) {
      setAuthKey(key);
      setIsEnabled(true);
    }
  }, []);

  const handleSave = () => {
    if (authKey.trim()) {
      setDhanBypassKey(authKey.trim());
      setIsEnabled(true);
      onKeyChange?.(true);
      setOpen(false);
    }
  };

  const handleClear = () => {
    clearDhanBypassKey();
    setAuthKey("");
    setIsEnabled(false);
    onKeyChange?.(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Dhan Bypass Configuration</DialogTitle>
          <DialogDescription>
            Enter your Dhan Bypass Auth Key to use direct API access
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="auth-key">Auth Key</Label>
            <Input
              id="auth-key"
              type="password"
              placeholder="Enter your auth key"
              value={authKey}
              onChange={(e) => setAuthKey(e.target.value)}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              This key will be stored in your browser session and used for API calls
            </p>
          </div>

          {isEnabled && (
            <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/20 rounded-md">
              <Check className="h-4 w-4 text-green-500" />
              <span className="text-sm text-green-600 dark:text-green-400">
                Dhan Bypass is currently enabled
              </span>
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleSave} className="flex-1">
              Save Key
            </Button>
            {isEnabled && (
              <Button onClick={handleClear} variant="destructive" className="flex-1">
                <X className="h-4 w-4 mr-2" />
                Clear Key
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

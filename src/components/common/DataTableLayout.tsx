import React, { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  PaginationEllipsis,
} from "@/components/ui/pagination";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  BarChart3,
  MoreVertical,
} from "lucide-react";

interface ActionButton {
  icon: React.ReactNode;
  tooltip: string;
  onClick: () => void;
  variant?: "default" | "outline" | "ghost";
  className?: string;
  disabled?: boolean;
}

interface DataTableLayoutProps {
  title: string;
  isLoading: boolean;
  totalCount: number;
  statChips: any[];
  actionButtons: ActionButton[];
  page: number;
  rowsPerPage: number;
  paginationEnabled: boolean;
  onPageChange: (page: number) => void;
  onRowsPerPageChange: (rows: string) => void;
  onPaginationToggle: (enabled: boolean) => void;
  renderTableHeader: () => React.ReactNode;
  renderTableBody: () => React.ReactNode;
  onRefresh: () => void;
  cookieName?: string;
  cookieMaxAge?: number;
  skeletonColumns?: number; // Number of columns for skeleton loader
  // Infinite scroll props (used when paginationEnabled is false)
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
}

const setCookie = (name: string, value: string, days: number = 30) => {
  try {
    const expires = new Date();
    expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
    document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/;SameSite=Lax`;
  } catch (error) {
    console.error("Error setting cookie:", error);
  }
};

const getCookie = (name: string): string | null => {
  try {
    if (typeof document === "undefined") return null;
    const nameEQ = name + "=";
    const ca = document.cookie.split(";");
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i];
      while (c.charAt(0) === " ") c = c.substring(1, c.length);
      if (c.indexOf(nameEQ) === 0) {
        return c.substring(nameEQ.length, c.length);
      }
    }
    return null;
  } catch (error) {
    console.error("Error getting cookie:", error);
    return null;
  }
};

const DataTableLayout: React.FC<DataTableLayoutProps> = ({
  title,
  isLoading,
  totalCount,
  statChips,
  actionButtons,
  page,
  rowsPerPage,
  paginationEnabled,
  onPageChange,
  onRowsPerPageChange,
  onPaginationToggle,
  renderTableHeader,
  renderTableBody,
  onRefresh,
  cookieName = "pagination_enabled",
  cookieMaxAge = 60 * 60 * 24 * 30,
  skeletonColumns = 7,
  onLoadMore,
  hasMore = false,
  isLoadingMore = false,
}) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [statsDialogOpen, setStatsDialogOpen] = useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Infinite scroll handler (used when pagination is disabled)
  const handleScroll = useCallback(() => {
    if (paginationEnabled || !onLoadMore || !hasMore || isLoadingMore) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight - scrollTop - clientHeight < 200) {
      onLoadMore();
    }
  }, [paginationEnabled, onLoadMore, hasMore, isLoadingMore]);

  useEffect(() => {
    if (typeof window !== "undefined" && !isInitialized) {
      const savedPaginationState = getCookie(cookieName);
      if (savedPaginationState !== null) {
        const shouldEnablePagination = savedPaginationState === "true";
        onPaginationToggle(shouldEnablePagination);
      }
      setIsInitialized(true);
    }
  }, [cookieName, onPaginationToggle, isInitialized]);

  const handlePaginationToggle = (checked: boolean) => {
    onPaginationToggle(checked);
    const daysToExpire = Math.ceil(cookieMaxAge / (24 * 60 * 60));
    setCookie(cookieName, checked.toString(), daysToExpire);
    if (checked) {
      onPageChange(1);
    }
  };

  const totalPages =
    paginationEnabled && totalCount > 0
      ? Math.ceil(totalCount / rowsPerPage)
      : 1;

  const getPaginationItems = () => {
    if (totalPages <= 1) return null;
    const items = [];
    const maxVisiblePages = 5;

    if (totalPages > 0) {
      items.push(
        <PaginationItem key={1}>
          <PaginationLink
            onClick={() => onPageChange(1)}
            isActive={page === 1}
            className={`cursor-pointer ${
              page === 1 ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""
            }`}
          >
            1
          </PaginationLink>
        </PaginationItem>
      );
    }

    if (page > 4 && totalPages > 6) {
      items.push(
        <PaginationItem key="start-ellipsis">
          <PaginationEllipsis />
        </PaginationItem>
      );
    }

    const start = Math.max(2, page - 2);
    const end = Math.min(totalPages - 1, page + 2);

    for (let i = start; i <= end; i++) {
      if (i !== 1 && i !== totalPages) {
        items.push(
          <PaginationItem key={i}>
            <PaginationLink
              onClick={() => onPageChange(i)}
              isActive={page === i}
              className={`cursor-pointer ${
                page === i ? "bg-primary text-primary-foreground hover:bg-primary/90" : ""
              }`}
            >
              {i}
            </PaginationLink>
          </PaginationItem>
        );
      }
    }

    if (page < totalPages - 3 && totalPages > 6) {
      items.push(
        <PaginationItem key="end-ellipsis">
          <PaginationEllipsis />
        </PaginationItem>
      );
    }

    if (totalPages > 1) {
      items.push(
        <PaginationItem key={totalPages}>
          <PaginationLink
            onClick={() => onPageChange(totalPages)}
            isActive={page === totalPages}
            className={`cursor-pointer ${
              page === totalPages
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : ""
            }`}
          >
            {totalPages}
          </PaginationLink>
        </PaginationItem>
      );
    }

    return items;
  };

  const getPageOptions = () => {
    const options = [];
    for (let i = 1; i <= totalPages; i++) {
      options.push(
        <SelectItem key={i} value={i.toString()}>
          {i}
        </SelectItem>
      );
    }
    return options;
  };

  // Separate primary and secondary action buttons
  const primaryButton = actionButtons.length > 0 ? actionButtons[0] : null;
  const secondaryButtons = actionButtons.slice(1);

  return (
    <div className="flex flex-col h-screen">
      {/* Page Title */}
      <div className="bg-card border-b border-border px-4 py-3 flex-shrink-0">
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      </div>

      {/* Stats and Actions Header - Responsive */}
      <div className="bg-card border-b border-border p-3 sm:p-4 flex-shrink-0">
        <div className="flex items-center justify-between gap-2">
          {/* Left side - Stats (Desktop) / Stats Dialog (Mobile) */}
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {/* Mobile: Stats Dialog */}
            <div className="sm:hidden">
              <Dialog open={statsDialogOpen} onOpenChange={setStatsDialogOpen}>
                <DialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2 bg-muted hover:bg-muted/80"
                  >
                    <BarChart3 className="h-4 w-4 mr-1" />
                    <span className="text-xs">Stats</span>
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Statistics</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-3 py-4">
                    {statChips.map((chip, index) => (
                      <div
                        key={index}
                        className={`flex items-center justify-between p-3 rounded-lg bg-muted border border-border ${
                          chip.onClick ? "cursor-pointer hover:bg-muted/80" : ""
                        }`}
                        onClick={chip.onClick}
                      >
                        <span className="text-sm font-medium text-foreground">
                          {chip.label}
                        </span>
                        <Badge
                          variant={chip.variant || "outline"}
                          className={`
          ${chip.bgColor || "bg-gray-100"} 
          ${chip.textColor || ""} 
          ${chip.hoverColor || ""}
        `}
                        >
                          {chip.value}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </DialogContent>
              </Dialog>
            </div>

            {/* Desktop: Stats Chips */}
            <div className="hidden sm:flex flex-wrap items-center gap-2">
              {statChips.map((chip, index) => (
                <span
                  key={index}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold whitespace-nowrap
                    ${chip.bgColor || "bg-muted"} 
                    ${chip.textColor || "text-foreground"} 
                    ${chip.borderColor || "border-border"}
                    ${chip.onClick ? "cursor-pointer" : ""}
                  `}
                  onClick={chip.onClick}
                >
                  {chip.icon && <span className="flex-shrink-0">{chip.icon}</span>}
                  <span>{chip.label}: {chip.value}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Right side - Action buttons */}
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            {/* Refresh Button */}
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onRefresh}
                    disabled={isLoading}
                    className="h-8 w-8 sm:h-9 sm:w-9 p-0 bg-muted hover:bg-muted/80"
                  >
                    <RefreshCw
                      className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Refresh Data</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>

            {/* Primary Action Button (Always visible) */}
            {primaryButton && (
              <>
                {primaryButton.className === '' ? (
                  // Render custom component directly (like search bar)
                  <div>{primaryButton.icon}</div>
                ) : (
                  // Render as button with tooltip
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant={primaryButton.variant || "outline"}
                          size="sm"
                          onClick={primaryButton.onClick}
                          disabled={primaryButton.disabled}
                          className={`h-8 w-8 sm:h-9 sm:w-9 p-0 ${
                            primaryButton.className || ""
                          }`}
                        >
                          {primaryButton.icon}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{primaryButton.tooltip}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </>
            )}

            {/* Mobile: More Actions Popover (for secondary buttons) */}
            {secondaryButtons.length > 0 && (
              <>
                <div className="sm:hidden">
                  <Popover
                    open={moreActionsOpen}
                    onOpenChange={setMoreActionsOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 w-8 p-0 bg-muted hover:bg-muted/80"
                      >
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-48 p-2" align="end">
                      <div className="flex flex-col gap-1">
                        {secondaryButtons.map((button, index) => (
                          <Button
                            key={index}
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              button.onClick();
                              setMoreActionsOpen(false);
                            }}
                            disabled={button.disabled}
                            className="w-full justify-start h-9"
                          >
                            <span className="mr-2">{button.icon}</span>
                            <span className="text-sm">{button.tooltip}</span>
                          </Button>
                        ))}
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>

                {/* Desktop: All Action Buttons */}
                <div className="hidden sm:flex items-center gap-2">
                  {secondaryButtons.map((button, index) => (
                    <React.Fragment key={index}>
                      {button.className === '' ? (
                        // Render custom component directly
                        <div>{button.icon}</div>
                      ) : (
                        // Render as button with tooltip
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant={button.variant || "outline"}
                                size="sm"
                                onClick={button.onClick}
                                disabled={button.disabled}
                                className={`h-9 w-9 p-0 ${button.className || ""}`}
                              >
                                {button.icon}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>{button.tooltip}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Scrollable Content Area */}
      <div className="flex-1 overflow-hidden">
        <Card className="h-full flex flex-col border-0 shadow-none">
          <CardContent className="flex-1 overflow-hidden p-0">
            {isLoading ? (
              <div className="h-full overflow-auto">
                <table className="w-full caption-bottom text-sm">
                  <thead className="sticky top-0 bg-background/95 backdrop-blur-sm z-30 border-b shadow-sm">
                    {renderTableHeader()}
                  </thead>
                  <tbody className="[&_tr:last-child]:border-0">
                    {/* Skeleton Loader Rows */}
                    {Array.from({ length: rowsPerPage }).map((_, index) => (
                      <tr key={index} className="border-b transition-colors">
                        {/* Generate skeleton cells based on skeletonColumns prop */}
                        {Array.from({ length: skeletonColumns }).map((_, cellIndex) => (
                          <td key={cellIndex} className="p-4 align-middle">
                            <div className="animate-pulse">
                              <div className="h-4 bg-muted rounded w-3/4"></div>
                            </div>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="h-full overflow-auto" ref={scrollContainerRef} onScroll={handleScroll}>
                <table className="w-full caption-bottom text-sm">
                  <thead className="sticky top-0 bg-background/95 backdrop-blur-sm z-30 border-b shadow-sm">
                    {renderTableHeader()}
                  </thead>
                  <tbody className="[&_tr:last-child]:border-0">
                    {renderTableBody()}
                  </tbody>
                </table>
                {/* Infinite scroll loading indicator */}
                {!paginationEnabled && isLoadingMore && (
                  <div className="flex justify-center items-center py-4">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    <span className="ml-2 text-sm text-muted-foreground">Loading more...</span>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Fixed Footer with Pagination - Responsive */}
      <div className="bg-card border-t border-border py-2 px-3 sm:px-4 flex-shrink-0">
        {/* Mobile Layout (Below 640px) */}
        <div className="flex sm:hidden items-center justify-between gap-2">
          {/* Left: Pagination Checkbox */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <Checkbox
              id="pagination-mobile"
              checked={paginationEnabled}
              onCheckedChange={(checked) =>
                handlePaginationToggle(checked as boolean)
              }
              className="h-4 w-4"
            />
            <Label
              htmlFor="pagination-mobile"
              className="text-xs text-muted-foreground cursor-pointer whitespace-nowrap"
            >
              Pagination
            </Label>
          </div>

          {/* Center: Prev/Next Buttons */}
          {paginationEnabled && totalPages > 0 && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => page > 1 && onPageChange(page - 1)}
                disabled={page <= 1}
                className="h-7 px-2"
              >
                <ChevronLeft className="h-3 w-3 mr-1" />
                <span className="text-xs">Prev</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => page < totalPages && onPageChange(page + 1)}
                disabled={page >= totalPages}
                className="h-7 px-2"
              >
                <span className="text-xs">Next</span>
                <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
            </div>
          )}

          {/* Right: Go to Page */}
          {paginationEnabled && totalPages > 0 && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">
                Go:
              </Label>
              <Select
                value={page.toString()}
                onValueChange={(value) => onPageChange(parseInt(value))}
              >
                <SelectTrigger className="h-7 w-12 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>{getPageOptions()}</SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* Desktop Layout (640px and above) */}
        <div className="hidden sm:flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-0">
          {/* Left side - Pagination controls */}
          <div className="flex items-center justify-between sm:justify-start gap-4 w-full sm:w-auto">
            <div className="flex items-center gap-2">
              <Checkbox
                id="pagination"
                checked={paginationEnabled}
                onCheckedChange={(checked) =>
                  handlePaginationToggle(checked as boolean)
                }
                className="h-4 w-4"
              />
              <Label
                htmlFor="pagination"
                className="text-sm text-muted-foreground cursor-pointer whitespace-nowrap"
              >
                Pagination
              </Label>
            </div>

            {paginationEnabled && (
              <div className="flex items-center gap-2 sm:ml-4">
                <Label className="text-sm text-muted-foreground whitespace-nowrap">
                  Rows:
                </Label>
                <Select
                  value={rowsPerPage.toString()}
                  onValueChange={onRowsPerPageChange}
                >
                  <SelectTrigger className="h-7 w-20 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10" className="text-xs">
                      10
                    </SelectItem>
                    <SelectItem value="20" className="text-xs">
                      20
                    </SelectItem>
                    <SelectItem value="50" className="text-xs">
                      50
                    </SelectItem>
                    <SelectItem value="100" className="text-xs">
                      100
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* Center - Pagination navigation */}
          {paginationEnabled && totalPages > 0 && (
            <div className="flex items-center justify-center w-full sm:w-auto">
              <Pagination className="justify-center">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      onClick={() => page > 1 && onPageChange(page - 1)}
                      className={
                        page <= 1
                          ? "pointer-events-none opacity-50"
                          : "cursor-pointer"
                      }
                    />
                  </PaginationItem>

                  {/* Always show page 1 when there's only one page */}
                  {totalPages === 1 ? (
                    <PaginationItem>
                      <PaginationLink
                        isActive={true}
                        className="cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        1
                      </PaginationLink>
                    </PaginationItem>
                  ) : (
                    getPaginationItems()
                  )}

                  <PaginationItem>
                    <PaginationNext
                      onClick={() =>
                        page < totalPages && onPageChange(page + 1)
                      }
                      className={
                        page >= totalPages
                          ? "pointer-events-none opacity-50"
                          : "cursor-pointer"
                      }
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          )}

          {/* Right side - Go to page and info */}
          <div className="flex items-center justify-between sm:justify-end gap-4 w-full sm:w-auto">
            {paginationEnabled && totalPages > 0 && (
              <>
                <div className="flex items-center gap-2">
                  <Label className="text-sm text-muted-foreground whitespace-nowrap">
                    Go to:
                  </Label>
                  <Select
                    value={page.toString()}
                    onValueChange={(value) => onPageChange(parseInt(value))}
                  >
                    <SelectTrigger className="h-7 w-16 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>{getPageOptions()}</SelectContent>
                  </Select>
                </div>

                <div className="hidden lg:flex text-sm text-muted-foreground whitespace-nowrap">
                  Total: {totalCount}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DataTableLayout;

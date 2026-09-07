import { Skeleton } from "@/lib/design/Skeleton";

function JobRowSkeleton() {
  return (
    <div className="flex flex-col gap-2.5 border-2 border-line-strong border-l-8 border-l-line bg-surface p-3.5">
      <div className="flex gap-3">
        <Skeleton className="h-8 w-8 flex-none" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Skeleton className="h-[16px] w-40" />
          <Skeleton className="h-[13px] w-32" />
        </div>
      </div>
      <Skeleton className="h-[44px] w-full" />
    </div>
  );
}

function ListPaneSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-[22px] w-48" />
      <div className="grid grid-cols-2 gap-2">
        <Skeleton className="h-[64px] w-full" />
        <Skeleton className="h-[64px] w-full" />
      </div>
      <div className="flex flex-col gap-3">
        <JobRowSkeleton />
        <JobRowSkeleton />
        <JobRowSkeleton />
      </div>
    </div>
  );
}

export default function DriverDayLoading() {
  return (
    <>
      {/* Phone */}
      <div className="lg:hidden">
        <ListPaneSkeleton />
      </div>

      {/* Tablet and up — same list rail + detail pane shape as the real page */}
      <div className="hidden lg:grid lg:grid-cols-[380px_1fr] lg:items-start lg:gap-5">
        <ListPaneSkeleton />
        <div className="flex flex-col gap-4 border-2 border-line-strong bg-surface p-5">
          <div className="flex items-center gap-2">
            <Skeleton className="h-[20px] w-20" />
            <Skeleton className="h-[20px] w-14" />
          </div>
          <Skeleton className="h-[70px] w-full" />
          <Skeleton className="h-[80px] w-full" />
          <Skeleton className="h-[60px] w-full" />
          <Skeleton className="h-[56px] w-full" />
        </div>
      </div>
    </>
  );
}

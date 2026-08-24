export default function DashboardLoading() {
  return (
    <main className="max-w-5xl mx-auto p-6">
      <div className="animate-pulse space-y-4">
        <div className="h-6 w-48 bg-gray-200 rounded" />
        <div className="h-4 w-72 bg-gray-100 rounded" />
        <div className="h-24 bg-gray-100 rounded mt-6" />
        <div className="h-24 bg-gray-100 rounded" />
      </div>
    </main>
  );
}

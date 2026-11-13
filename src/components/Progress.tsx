interface ProgressProps {
  text: string;
  percentage?: number;
}

export default function Progress({ text, percentage }: ProgressProps) {
  const value = percentage ?? 0;

  return (
    <div
      style={{
        backgroundColor: '#e9ecef',
        borderRadius: '8px',
        overflow: 'hidden',
        marginBottom: '8px',
        border: '1px solid #ced4da',
      }}
    >
      <div
        style={{
          width: `${value}%`,
          backgroundColor: '#007bff',
          color: '#fff',
          padding: '4px 10px',
          fontSize: '13px',
          whiteSpace: 'nowrap',
          transition: 'width 0.15s ease',
        }}
      >
        {text} ({value.toFixed(1)}%)
      </div>
    </div>
  );
}
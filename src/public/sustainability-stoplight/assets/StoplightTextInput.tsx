import { useState } from 'react';
import { StimulusParams } from '../../../store/types';

interface TextInputParams {
  questionId: string;
  questionText: string;
  placeholder: string;
}

// This component creates a styled text input for general comments
// maintaining the sustainability stoplight theme
function StoplightTextInput({ parameters, setAnswer }: StimulusParams<TextInputParams>) {
  const [textValue, setTextValue] = useState<string>('');

  const { questionId, questionText, placeholder } = parameters;

  // Handle text input
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const { value } = e.target;
    setTextValue(value);
    setAnswer({
      status: true,
      answers: {
        [questionId]: value,
      },
    });
  };

  return (
    <div style={{
      maxWidth: '900px',
      margin: '0 auto',
      padding: '40px 20px',
      fontFamily: 'Arial, sans-serif',
    }}
    >
      {/* Question Title */}
      <h2 style={{
        fontSize: '24px',
        marginBottom: '30px',
        textAlign: 'center',
        color: '#333',
      }}
      >
        {questionText}
      </h2>

      {/* Styled Card Container */}
      <div style={{
        backgroundColor: 'white',
        border: '3px solid #72B856',
        borderRadius: '12px',
        padding: '30px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
      }}
      >
        {/* Icon Header */}
        <div style={{
          textAlign: 'center',
          marginBottom: '20px',
          fontSize: '48px',
        }}
        >
          💬
        </div>

        {/* Text Area */}
        <textarea
          value={textValue}
          onChange={handleTextChange}
          placeholder={placeholder}
          style={{
            width: '100%',
            minHeight: '200px',
            padding: '15px',
            fontSize: '16px',
            fontFamily: 'Arial, sans-serif',
            border: '2px solid #ddd',
            borderRadius: '8px',
            resize: 'vertical',
            outline: 'none',
            transition: 'border-color 0.3s ease',
          }}
          onFocus={(e) => {
            e.target.style.borderColor = '#72B856';
          }}
          onBlur={(e) => {
            e.target.style.borderColor = '#ddd';
          }}
        />

        {/* Character count */}
        <div style={{
          marginTop: '10px',
          textAlign: 'right',
          fontSize: '14px',
          color: '#666',
        }}
        >
          {textValue.length}
          {' '}
          characters
        </div>
      </div>

      {/* Helpful hint */}
      <div style={{
        marginTop: '20px',
        padding: '15px',
        backgroundColor: '#E8F5E9',
        border: '2px solid #72B856',
        borderRadius: '8px',
        textAlign: 'center',
        fontSize: '14px',
        color: '#2e7d32',
      }}
      >
        💡 Your feedback helps us improve! Feel free to share any thoughts, suggestions, or concerns.
      </div>
    </div>
  );
}

export default StoplightTextInput;

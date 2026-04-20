import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import {
  Button,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

/**
 * Labeled section wrapper. Nested so the inspector's fiber walk
 * produces a component stack with user-defined components.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => setCount((c) => c - 1)}
        style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
      >
        <Text style={styles.pillText}>−</Text>
      </Pressable>
      <Text style={styles.counterValue}>{count}</Text>
      <Pressable
        onPress={() => setCount((c) => c + 1)}
        style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
      >
        <Text style={styles.pillText}>+</Text>
      </Pressable>
    </View>
  );
}

function GreetingForm() {
  const [name, setName] = useState('');
  const [greeting, setGreeting] = useState('');
  return (
    <View>
      <TextInput
        placeholder="Your name"
        placeholderTextColor="#888"
        value={name}
        onChangeText={setName}
        style={styles.input}
      />
      <View style={{ height: 8 }} />
      <Button title="Say hi" onPress={() => setGreeting(name ? `Hi, ${name}!` : '…')} />
      {greeting ? <Text style={styles.greeting}>{greeting}</Text> : null}
    </View>
  );
}

function Toggle() {
  const [on, setOn] = useState(false);
  return (
    <View style={styles.row}>
      <Text style={styles.label}>Dark ritual mode</Text>
      <Switch value={on} onValueChange={setOn} />
    </View>
  );
}

export default function App() {
  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.heading}>Sim Preview Demo</Text>
        <Text style={styles.subheading}>Click elements in the browser to inspect them.</Text>

        <Section title="Counter">
          <Counter />
        </Section>

        <Section title="Greeting form">
          <GreetingForm />
        </Section>

        <Section title="Toggle">
          <Toggle />
        </Section>

        <Section title="Nested boxes">
          <View style={[styles.box, { backgroundColor: '#1e3a8a' }]}>
            <View style={[styles.box, { backgroundColor: '#2563eb' }]}>
              <View style={[styles.box, { backgroundColor: '#60a5fa' }]}>
                <Text style={styles.boxText}>inner</Text>
              </View>
            </View>
          </View>
        </Section>

        <Section title="Scroll test">
          {Array.from({ length: 25 }).map((_, i) => (
            <View key={i} style={styles.listRow}>
              <Text style={styles.listText}>Row #{i + 1}</Text>
            </View>
          ))}
        </Section>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  scroll: { padding: 20, paddingTop: 60, gap: 18 },
  heading: { color: '#f8fafc', fontSize: 28, fontWeight: '700' },
  subheading: { color: '#94a3b8', fontSize: 14, marginBottom: 8 },
  section: {
    backgroundColor: '#1e293b',
    padding: 14,
    borderRadius: 12,
    gap: 10,
  },
  sectionTitle: {
    color: '#cbd5e1',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  sectionBody: { gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  label: { color: '#e2e8f0', fontSize: 16 },
  input: {
    backgroundColor: '#0f172a',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#f8fafc',
    fontSize: 16,
  },
  greeting: { color: '#a7f3d0', marginTop: 10, fontSize: 16 },
  pill: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#334155',
  },
  pillPressed: { opacity: 0.6 },
  pillText: { color: '#f8fafc', fontSize: 22, fontWeight: '600' },
  counterValue: {
    color: '#f8fafc',
    fontSize: 24,
    fontWeight: '700',
    minWidth: 40,
    textAlign: 'center',
  },
  box: {
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxText: { color: '#f8fafc', fontSize: 12 },
  listRow: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    backgroundColor: '#0f172a',
  },
  listText: { color: '#e2e8f0', fontSize: 14 },
});

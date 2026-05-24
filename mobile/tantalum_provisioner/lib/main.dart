import 'dart:convert';

import 'package:appwrite/appwrite.dart';
import 'package:flutter/material.dart';

import 'provisioning_bridge.dart';

const appwriteEndpoint = String.fromEnvironment('APPWRITE_ENDPOINT');
const appwriteProjectId = String.fromEnvironment('APPWRITE_PROJECT_ID');
const appwriteDatabaseId = String.fromEnvironment('APPWRITE_DATABASE_ID');
const boardsCollectionId =
    String.fromEnvironment('APPWRITE_BOARDS_COLLECTION_ID');
const boardAdminFunctionId =
    String.fromEnvironment('APPWRITE_BOARD_ADMIN_FUNCTION_ID');

void main() {
  runApp(const TantalumProvisionerApp());
}

class TantalumProvisionerApp extends StatelessWidget {
  const TantalumProvisionerApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Tantalum Provisioner',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xff2563eb)),
        useMaterial3: true,
      ),
      home: const ProvisionerHome(),
    );
  }
}

class ProvisionerHome extends StatefulWidget {
  const ProvisionerHome({super.key});

  @override
  State<ProvisionerHome> createState() => _ProvisionerHomeState();
}

class _ProvisionerHomeState extends State<ProvisionerHome> {
  late final Client client;
  late final Account account;
  late final Databases databases;
  late final Functions functions;
  final bridge = ProvisioningBridge();
  final emailController = TextEditingController();
  final passwordController = TextEditingController();
  final ssidController = TextEditingController();
  final wifiPasswordController = TextEditingController();
  List<Map<String, dynamic>> boards = [];
  Map<String, dynamic>? selectedBoard;
  bool authenticated = false;
  bool busy = false;
  String message = '';

  @override
  void initState() {
    super.initState();
    client = Client()
      ..setEndpoint(appwriteEndpoint)
      ..setProject(appwriteProjectId);
    account = Account(client);
    databases = Databases(client);
    functions = Functions(client);
    _loadSession();
  }

  @override
  void dispose() {
    emailController.dispose();
    passwordController.dispose();
    ssidController.dispose();
    wifiPasswordController.dispose();
    super.dispose();
  }

  Future<void> _loadSession() async {
    if (appwriteEndpoint.isEmpty || appwriteProjectId.isEmpty) {
      setState(() => message = 'Appwrite configuration is missing.');
      return;
    }

    try {
      await account.get();
      setState(() => authenticated = true);
      await _loadBoards();
    } catch (_) {
      setState(() => authenticated = false);
    }
  }

  Future<void> _signIn() async {
    setState(() {
      busy = true;
      message = '';
    });
    try {
      await account.createEmailSession(
        email: emailController.text.trim(),
        password: passwordController.text,
      );
      setState(() => authenticated = true);
      await _loadBoards();
    } catch (error) {
      setState(() => message = error.toString());
    } finally {
      setState(() => busy = false);
    }
  }

  Future<void> _loadBoards() async {
    final response = await databases.listDocuments(
      databaseId: appwriteDatabaseId,
      collectionId: boardsCollectionId,
    );
    setState(() {
      boards = response.documents.map((document) => document.data).toList();
      selectedBoard = boards.isEmpty ? null : boards.first;
    });
  }

  bool _usesSoftAp(Map<String, dynamic> board) {
    final type = '${board['boardType'] ?? ''}'.toLowerCase();
    return type.contains('esp32s2') || type.contains('esp8266');
  }

  String _fallbackServiceName(Map<String, dynamic> board) {
    final id = '${board[r'$id'] ?? ''}';
    final suffix = id.length > 8 ? id.substring(id.length - 8) : id;
    return 'Tantalum-$suffix';
  }

  Future<Map<String, dynamic>> _requestProvisioning(
      Map<String, dynamic> board) async {
    final execution = await functions.createExecution(
      functionId: boardAdminFunctionId,
      body: jsonEncode({
        'boardId': board[r'$id'],
        'mode': _usesSoftAp(board) ? 'softap' : 'ble'
      }),
      async: false,
      path: '/start-provisioning',
      method: ExecutionMethod.pOST,
      headers: {'content-type': 'application/json'},
    );

    final parsed = jsonDecode(execution.responseBody) as Map<String, dynamic>;
    if (execution.responseStatusCode >= 400 || parsed['ok'] != true) {
      throw Exception(parsed['error'] ?? 'Provisioning request failed.');
    }
    return (parsed['data'] as Map).cast<String, dynamic>();
  }

  Future<void> _provisionSelectedBoard() async {
    final board = selectedBoard;
    if (board == null) {
      return;
    }

    if (ssidController.text.trim().isEmpty) {
      setState(() => message = 'Enter a WiFi SSID.');
      return;
    }

    setState(() {
      busy = true;
      message = '';
    });

    try {
      final response = await _requestProvisioning(board);
      final provisioning =
          (response['provisioning'] as Map?)?.cast<String, dynamic>() ?? {};
      final serviceName =
          '${provisioning['serviceName'] ?? _fallbackServiceName(board)}';
      final pop = '${provisioning['pop'] ?? board['provisioningPop'] ?? ''}';

      if (_usesSoftAp(board)) {
        await bridge.provisionSoftAp(
          serviceName: serviceName,
          pop: pop,
          ssid: ssidController.text.trim(),
          password: wifiPasswordController.text,
        );
      } else {
        await bridge.provisionBle(
          serviceName: serviceName,
          pop: pop,
          ssid: ssidController.text.trim(),
          password: wifiPasswordController.text,
        );
      }

      setState(() =>
          message = 'WiFi credentials sent to ${board['name'] ?? 'board'}.');
      await _loadBoards();
    } catch (error) {
      setState(() => message = error.toString());
    } finally {
      setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tantalum Provisioner')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            if (!authenticated) _buildLogin(),
            if (authenticated) _buildProvisioner(),
            if (message.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 16),
                child: Text(message),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildLogin() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: emailController,
          keyboardType: TextInputType.emailAddress,
          decoration: const InputDecoration(labelText: 'Email'),
        ),
        TextField(
          controller: passwordController,
          obscureText: true,
          decoration: const InputDecoration(labelText: 'Password'),
        ),
        const SizedBox(height: 16),
        FilledButton(
          onPressed: busy ? null : _signIn,
          child: Text(busy ? 'Signing in...' : 'Sign in'),
        ),
      ],
    );
  }

  Widget _buildProvisioner() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DropdownButtonFormField<Map<String, dynamic>>(
          value: selectedBoard,
          items: boards.map((board) {
            return DropdownMenuItem(
              value: board,
              child: Text(
                  '${board['name'] ?? 'Board'} (${board['boardType'] ?? 'unknown'})'),
            );
          }).toList(),
          onChanged:
              busy ? null : (board) => setState(() => selectedBoard = board),
          decoration: const InputDecoration(labelText: 'Board'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: ssidController,
          decoration: const InputDecoration(labelText: 'WiFi SSID'),
        ),
        TextField(
          controller: wifiPasswordController,
          obscureText: true,
          decoration: const InputDecoration(labelText: 'WiFi password'),
        ),
        const SizedBox(height: 16),
        FilledButton(
          onPressed:
              busy || selectedBoard == null ? null : _provisionSelectedBoard,
          child: Text(busy ? 'Provisioning...' : 'Send WiFi credentials'),
        ),
        const SizedBox(height: 16),
        OutlinedButton(
          onPressed: busy ? null : _loadBoards,
          child: const Text('Refresh boards'),
        ),
      ],
    );
  }
}

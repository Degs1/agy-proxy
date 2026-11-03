// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CreateProjectModal } from '@/components/projects/create-project-modal';
import { EditProjectModal } from '@/components/projects/edit-project-modal';
import { CreateCredentialModal } from '@/components/credentials/create-credential-modal';
import { RotateKeyModal } from '@/components/credentials/rotate-key-modal';
import { CreateAliasModal } from '@/components/aliases/create-alias-modal';
import { Project, ProviderCredential } from '@/lib/frontend/types';

describe('Admin Management Components & Business Logic (TASK-069)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('CreateProjectModal', () => {
    it('creates project with default RPM (60) and Concurrency (5)', async () => {
      const handleClose = vi.fn();
      const handleSuccess = vi.fn();
      const mockFetchWithCsrf = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        expect(body.name).toBe('AI Assistant Pro');
        expect(body.rpmLimit).toBe(60);
        expect(body.concurrencyLimit).toBe(5);
        expect(body.allowedModels).toEqual(['gemini-default']);

        return Promise.resolve(
          new Response(
            JSON.stringify({
              project: {
                id: 'proj_123',
                name: 'AI Assistant Pro',
                status: 'active',
                rpmLimit: 60,
                concurrencyLimit: 5,
                allowedModels: ['gemini-default'],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
            }),
            { status: 201, headers: { 'Content-Type': 'application/json' } }
          )
        );
      });

      render(
        <CreateProjectModal
          isOpen={true}
          onClose={handleClose}
          onSuccess={handleSuccess}
          fetchWithCsrf={mockFetchWithCsrf}
        />
      );

      const nameInput = screen.getByLabelText(/Nama Project/i);
      fireEvent.change(nameInput, { target: { value: 'AI Assistant Pro' } });

      const submitBtn = screen.getByRole('button', { name: /Simpan Project/i });
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      expect(mockFetchWithCsrf).toHaveBeenCalledTimes(1);
      expect(handleSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'proj_123', name: 'AI Assistant Pro' })
      );
      expect(handleClose).toHaveBeenCalledTimes(1);
    });

    it('displays error feedback when API returns validation failure', async () => {
      const handleClose = vi.fn();
      const handleSuccess = vi.fn();
      const mockFetchWithCsrf = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'invalid_request', message: 'Project name already exists' },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      );

      render(
        <CreateProjectModal
          isOpen={true}
          onClose={handleClose}
          onSuccess={handleSuccess}
          fetchWithCsrf={mockFetchWithCsrf}
        />
      );

      const nameInput = screen.getByLabelText(/Nama Project/i);
      fireEvent.change(nameInput, { target: { value: 'Duplicate Project' } });

      const submitBtn = screen.getByRole('button', { name: /Simpan Project/i });
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      expect(screen.getByRole('alert')).toHaveTextContent('Project name already exists');
      expect(handleSuccess).not.toHaveBeenCalled();
      expect(handleClose).not.toHaveBeenCalled();
    });
  });

  describe('EditProjectModal', () => {
    it('populates existing project configuration and patches updates', async () => {
      const existingProject: Project = {
        id: 'proj_abc',
        name: 'Existing Bot',
        status: 'active',
        rpmLimit: 60,
        concurrencyLimit: 5,
        allowedModels: ['gemini-default'],
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
      };

      const handleClose = vi.fn();
      const handleSuccess = vi.fn();
      const mockFetchWithCsrf = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        expect(url).toBe('/api/admin/projects/proj_abc');
        expect(init?.method).toBe('PATCH');
        const body = JSON.parse(init?.body as string);
        expect(body.rpmLimit).toBe(120);
        expect(body.concurrencyLimit).toBe(10);
        expect(body.status).toBe('disabled');

        return Promise.resolve(
          new Response(
            JSON.stringify({
              project: { ...existingProject, rpmLimit: 120, concurrencyLimit: 10, status: 'disabled' },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      });

      render(
        <EditProjectModal
          isOpen={true}
          project={existingProject}
          onClose={handleClose}
          onSuccess={handleSuccess}
          fetchWithCsrf={mockFetchWithCsrf}
        />
      );

      const rpmInput = screen.getByLabelText(/Batas RPM/i);
      fireEvent.change(rpmInput, { target: { value: '120' } });

      const concInput = screen.getByLabelText(/Batas Concurrency/i);
      fireEvent.change(concInput, { target: { value: '10' } });

      const statusSelect = screen.getByLabelText(/Status Operasional/i);
      fireEvent.change(statusSelect, { target: { value: 'disabled' } });

      const saveBtn = screen.getByRole('button', { name: /Simpan Perubahan/i });
      await act(async () => {
        fireEvent.click(saveBtn);
      });

      expect(mockFetchWithCsrf).toHaveBeenCalledTimes(1);
      expect(handleSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ rpmLimit: 120, concurrencyLimit: 10, status: 'disabled' })
      );
      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('CreateCredentialModal', () => {
    it('restricts provider to Gemini API and disables Antigravity option', async () => {
      const handleClose = vi.fn();
      const handleSuccess = vi.fn();
      const mockFetchWithCsrf = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            credential: {
              id: 'cred_1',
              projectId: 'p1',
              provider: 'gemini',
              displayName: 'Gemini Primary',
              credentialType: 'api_key',
              status: 'active',
              keyVersion: 1,
              maxConcurrent: null,
              lastUsedAt: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      );

      render(
        <CreateCredentialModal
          isOpen={true}
          projectId="p1"
          onClose={handleClose}
          onSuccess={handleSuccess}
          fetchWithCsrf={mockFetchWithCsrf}
        />
      );

      // Verify Antigravity option is disabled in the dropdown
      const antigravityOption = screen.getByRole('option', {
        name: /Google Antigravity \(Unsupported \/ Pending Verification\)/i,
      }) as HTMLOptionElement;
      expect(antigravityOption.disabled).toBe(true);

      const geminiOption = screen.getByRole('option', {
        name: /Google Gemini API resmi/i,
      }) as HTMLOptionElement;
      expect(geminiOption.disabled).toBe(false);

      const nameInput = screen.getByLabelText(/Display Name/i);
      fireEvent.change(nameInput, { target: { value: 'Gemini Primary' } });

      const secretInput = screen.getByLabelText(/Gemini API Key Secret/i);
      fireEvent.change(secretInput, { target: { value: 'AIzaSySecretKey999' } });

      const submitBtn = screen.getByRole('button', { name: /Enkripsi & Simpan Kredensial/i });
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      expect(mockFetchWithCsrf).toHaveBeenCalledWith(
        '/api/admin/projects/p1/credentials',
        expect.objectContaining({
          method: 'POST',
        })
      );
      expect(handleSuccess).toHaveBeenCalledTimes(1);
    });
  });

  describe('RotateKeyModal', () => {
    it('executes encryption key re-encryption and calls onSuccess', async () => {
      const credential: ProviderCredential = {
        id: 'cred_rotate_1',
        projectId: 'p1',
        provider: 'gemini',
        displayName: 'Old Key',
        credentialType: 'api_key',
        status: 'active',
        keyVersion: 1,
        maxConcurrent: null,
        lastUsedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const handleClose = vi.fn();
      const handleSuccess = vi.fn();
      const mockFetchWithCsrf = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            credential: { ...credential, keyVersion: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      render(
        <RotateKeyModal
          isOpen={true}
          projectId="p1"
          credential={credential}
          onClose={handleClose}
          onSuccess={handleSuccess}
          fetchWithCsrf={mockFetchWithCsrf}
        />
      );

      expect(screen.getByText(/Versi Kunci Saat Ini: v1/i)).toBeTruthy();

      const rotateBtn = screen.getByRole('button', { name: /Jalankan Rotasi Kunci/i });
      await act(async () => {
        fireEvent.click(rotateBtn);
      });

      expect(mockFetchWithCsrf).toHaveBeenCalledWith(
        '/api/admin/projects/p1/credentials/cred_rotate_1/rotate',
        expect.objectContaining({ method: 'POST' })
      );
      expect(handleSuccess).toHaveBeenCalledWith(expect.objectContaining({ keyVersion: 2 }));
      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('CreateAliasModal', () => {
    it('only lists active Gemini credentials from the same project in the binding dropdown', async () => {
      const credentials: ProviderCredential[] = [
        {
          id: 'cred_proj1_active',
          projectId: 'proj_1',
          provider: 'gemini',
          displayName: 'Gemini Active P1',
          credentialType: 'api_key',
          status: 'active',
          keyVersion: 1,
          maxConcurrent: null,
          lastUsedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'cred_proj1_disabled',
          projectId: 'proj_1',
          provider: 'gemini',
          displayName: 'Gemini Inactive P1',
          credentialType: 'api_key',
          status: 'disabled', // Disabled, must NOT be in options
          keyVersion: 1,
          maxConcurrent: null,
          lastUsedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'cred_proj2_active',
          projectId: 'proj_2', // Cross-project, must NOT be in options
          provider: 'gemini',
          displayName: 'Gemini Active P2',
          credentialType: 'api_key',
          status: 'active',
          keyVersion: 1,
          maxConcurrent: null,
          lastUsedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const handleClose = vi.fn();
      const handleSuccess = vi.fn();
      const mockFetchWithCsrf = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            alias: {
              id: 'alias_1',
              projectId: 'proj_1',
              alias: 'gemini-default',
              upstreamModel: 'gemini-2.5-flash',
              boundCredentialId: 'cred_proj1_active',
              status: 'active',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } }
        )
      );

      render(
        <CreateAliasModal
          isOpen={true}
          projectId="proj_1"
          credentials={credentials}
          onClose={handleClose}
          onSuccess={handleSuccess}
          fetchWithCsrf={mockFetchWithCsrf}
        />
      );

      // Verify that ONLY cred_proj1_active is listed in options
      expect(screen.getByRole('option', { name: /Gemini Active P1/i })).toBeTruthy();
      expect(screen.queryByRole('option', { name: /Gemini Inactive P1/i })).toBeNull();
      expect(screen.queryByRole('option', { name: /Gemini Active P2/i })).toBeNull();

      const aliasInput = screen.getByLabelText(/Nama Alias Publik/i);
      fireEvent.change(aliasInput, { target: { value: 'gemini-default' } });

      const credSelect = screen.getByLabelText(/Kredensial Gemini Terikat/i);
      fireEvent.change(credSelect, { target: { value: 'cred_proj1_active' } });

      const submitBtn = screen.getByRole('button', { name: /Ikat Model Alias/i });
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      expect(mockFetchWithCsrf).toHaveBeenCalledWith(
        '/api/admin/projects/proj_1/aliases',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            alias: 'gemini-default',
            upstreamModel: 'gemini-2.5-flash',
            boundCredentialId: 'cred_proj1_active',
            status: 'active',
          }),
        })
      );
      expect(handleSuccess).toHaveBeenCalledTimes(1);
    });
  });
});

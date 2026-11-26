import { randomBytes } from "node:crypto"
import {
    type ArgumentsHost,
    Body,
    Catch,
    Controller,
    type DynamicModule,
    type ExceptionFilter,
    Get,
    HttpCode,
    HttpException,
    Inject,
    Logger,
    Module,
    NotFoundException,
    Post,
    Put,
} from "@nestjs/common"
import { APP_FILTER, ModuleRef } from "@nestjs/core"
import type { Response } from "express"
import { Database, SCHEMA } from "./database"
import { env } from "./env"
import { isTransient } from "./errors"
import { FAULT_HOOK, type FaultHook, type Faults, FaultsService } from "./faults"

/** Each service puts its own sample data back for the specs, registered under this token. */
export interface Seeder {
    reset(): Promise<void>
}
export const SEEDER = Symbol("SEEDER")
const SERVICE_NAME = Symbol("SERVICE_NAME")

/** A new id per process start: the crash spec reads it to know payments really restarted. */
export const BOOT_ID = randomBytes(8).toString("hex")

/** Whether the test hooks (fault switches, sample data reset, read-only views) answer in this process. */
export const testHooksOn = (): boolean => env("TEST_HOOKS", "off") === "on"

/** Answers 404 unless the test hooks are on, so a production deployment exposes none of them. */
export const requireHooks = (): void => {
    if (!testHooksOn()) throw new NotFoundException()
}

@Controller()
/** Health for docker, and the test hooks: `PUT /lab/chaos` sets fault switches, `POST /lab/reset` puts the sample data back. */
export class ServiceController {
    constructor(
        @Inject(SERVICE_NAME) private readonly service: string,
        private readonly moduleRef: ModuleRef,
        private readonly faults: FaultsService,
    ) {}

    @Get("health")
    health(): { ok: true; service: string; bootId: string } {
        return { ok: true, service: this.service, bootId: BOOT_ID }
    }

    @Get("lab/chaos")
    getFaults(): Faults {
        requireHooks()
        return this.faults.get()
    }

    @Put("lab/chaos")
    async setFaults(@Body() patch: Record<string, unknown>): Promise<Faults> {
        requireHooks()
        const applied = this.faults.set(patch ?? {})
        await this.hook()?.applied(applied)
        return this.faults.get()
    }

    @Post("lab/reset")
    @HttpCode(200)
    async reset(): Promise<{ ok: true; service: string }> {
        requireHooks()
        this.faults.reset()
        await this.moduleRef.get<Seeder>(SEEDER, { strict: false }).reset()
        return { ok: true, service: this.service }
    }

    /** The service's own reaction to a switch, if it registered one under FAULT_HOOK (payments does, shop does not). */
    private readonly hook = (): FaultHook | null => {
        try {
            return this.moduleRef.get<FaultHook>(FAULT_HOOK, { strict: false })
        } catch {
            return null
        }
    }
}

@Catch()
/**
 * Turns errors into answers. A business answer (`HttpException`) keeps its status and body. A transient database failure is a
 * 503 `TRY_AGAIN`: nothing was decided, so the caller resends with the same key. Anything else is a 500.
 */
export class ErrorsFilter implements ExceptionFilter {
    private readonly logger = new Logger("errors")

    catch(error: unknown, host: ArgumentsHost): void {
        const res = host.switchToHttp().getResponse<Response>()
        if (error instanceof HttpException) {
            res.status(error.getStatus()).json(error.getResponse())
            return
        }
        const message = error instanceof Error ? error.message : String(error)
        if (isTransient(error)) {
            this.logger.warn(`transient: ${message}`)
            res.status(503).json({ error: "TRY_AGAIN", message })
            return
        }
        this.logger.error(message, error instanceof Error ? error.stack : undefined)
        res.status(500).json({ error: "INTERNAL", message })
    }
}

@Module({})
/** What every service shares: its database and schema, the fault switches, health and the error answers. */
export class ServiceModule {
    static forService(service: string, schema: ReadonlyArray<string>): DynamicModule {
        return {
            module: ServiceModule,
            global: true,
            controllers: [ServiceController],
            providers: [
                { provide: SERVICE_NAME, useValue: service },
                { provide: SCHEMA, useValue: schema },
                Database,
                FaultsService,
                { provide: APP_FILTER, useClass: ErrorsFilter },
            ],
            exports: [Database, FaultsService],
        }
    }
}

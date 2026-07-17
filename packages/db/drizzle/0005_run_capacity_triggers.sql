CREATE OR REPLACE FUNCTION public.enforce_queued_run_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'QUEUED'::public.run_status THEN
    IF TG_OP = 'UPDATE' AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
      RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('platform:queued-runs', 0));
    IF (SELECT count(*) FROM public.runs WHERE status = 'QUEUED'::public.run_status) >= 3 THEN
      NEW.status := 'REJECTED_BY_CAPACITY'::public.run_status;
      RETURN NEW;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER runs_enforce_queued_capacity
BEFORE INSERT OR UPDATE OF status ON public.runs
FOR EACH ROW
EXECUTE FUNCTION public.enforce_queued_run_capacity();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.enforce_active_run_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN (
    'PLANNING'::public.run_status,
    'EXECUTING'::public.run_status,
    'ANALYZING'::public.run_status,
    'REPORTING'::public.run_status,
    'CANCEL_REQUESTED'::public.run_status
  ) THEN
    IF TG_OP = 'UPDATE' AND OLD.status IN (
      'PLANNING'::public.run_status,
      'EXECUTING'::public.run_status,
      'ANALYZING'::public.run_status,
      'REPORTING'::public.run_status,
      'CANCEL_REQUESTED'::public.run_status
    ) THEN
      RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('platform:active-runs', 0));
    IF (
      SELECT count(*) FROM public.runs WHERE status IN (
        'PLANNING'::public.run_status,
        'EXECUTING'::public.run_status,
        'ANALYZING'::public.run_status,
        'REPORTING'::public.run_status,
        'CANCEL_REQUESTED'::public.run_status
      )
    ) >= 1 THEN
      NEW.status := 'REJECTED_BY_CAPACITY'::public.run_status;
      RETURN NEW;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER runs_enforce_active_capacity
BEFORE INSERT OR UPDATE OF status ON public.runs
FOR EACH ROW
EXECUTE FUNCTION public.enforce_active_run_capacity();
